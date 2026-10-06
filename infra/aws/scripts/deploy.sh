#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repository_root"
export AWS_PAGER=""
region="${AWS_REGION:?Set AWS_REGION to your production region.}"
stack="${AWS_STACK_NAME:-invookemail-prod}"
aws_options=(--region "$region" --no-cli-pager)
if [[ -n "${AWS_PROFILE:-}" ]]; then aws_options+=(--profile "$AWS_PROFILE"); fi
export AWS_REGION="$region" AWS_STACK_NAME="$stack"
aws_cli() { aws "${aws_options[@]}" "$@"; }
cdk_cli() {
  local arguments=("$@")
  if [[ -n "${AWS_PROFILE:-}" ]]; then arguments+=(--profile "$AWS_PROFILE"); fi
  pnpm --dir infra/aws exec cdk "${arguments[@]}"
}
output() {
  aws_cli cloudformation describe-stacks --stack-name "$stack" --output json |
    jq -er --arg key "$1" '.Stacks[0].Outputs[] | select(.OutputKey == $key) | .OutputValue'
}
assume_task_operations() {
  local credentials
  credentials="$(aws_cli sts assume-role --role-arn "$(output TaskOperationsRoleArn)" --role-session-name invookemail-release --query Credentials --output json)"
  task_access_key="$(printf '%s' "$credentials" | jq -er '.AccessKeyId')"
  task_secret_key="$(printf '%s' "$credentials" | jq -er '.SecretAccessKey')"
  task_session_token="$(printf '%s' "$credentials" | jq -er '.SessionToken')"
}
task_cli() (
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  export AWS_ACCESS_KEY_ID="${task_access_key:?Assume the task operations role first.}"
  export AWS_SECRET_ACCESS_KEY="${task_secret_key:?Assume the task operations role first.}"
  export AWS_SESSION_TOKEN="${task_session_token:?Assume the task operations role first.}"
  aws --region "$region" --no-cli-pager "$@"
)
apply_stack() {
  local arguments=(deploy "$stack" --require-approval never)
  if [[ -n "${AWS_CLOUDFORMATION_ROLE_ARN:-}" ]]; then arguments+=(--role-arn "$AWS_CLOUDFORMATION_ROLE_ARN"); fi
  for parameter in "$@"; do arguments+=(--parameters "$stack:$parameter"); done
  cdk_cli "${arguments[@]}"
}

for command in aws jq node pnpm; do command -v "$command" >/dev/null; done

case "${1:-}" in
  bootstrap)
    vpc_id="$(aws_cli ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
    [[ "$vpc_id" != None && -n "$vpc_id" ]] || { echo "This region has no default VPC." >&2; exit 1; }
    subnets="$(aws_cli ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc_id" Name=default-for-az,Values=true \
      --output json | jq -er '[.Subnets[] | select(.MapPublicIpOnLaunch) | .SubnetId] | if length < 2 then error("At least two default public subnets are required") else join(",") end')"
    for subnet in ${subnets//,/ }; do
      routes="$(aws_cli ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$subnet" --output json)"
      if [[ "$(printf '%s' "$routes" | jq '.RouteTables | length')" == 0 ]]; then
        routes="$(aws_cli ec2 describe-route-tables --filters "Name=vpc-id,Values=$vpc_id" Name=association.main,Values=true --output json)"
      fi
      printf '%s' "$routes" | jq -e '.RouteTables[].Routes[] | select(.DestinationCidrBlock == "0.0.0.0/0" and .State == "active" and ((.GatewayId // "") | startswith("igw-")))' >/dev/null
    done
    if ! aws_cli cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
      account="$(aws_cli sts get-caller-identity --query Account --output text)"
      cdk_cli bootstrap "aws://$account/$region"
    fi
    principal_arn="${AWS_DEPLOYMENT_PRINCIPAL_ARN:-$(aws_cli sts get-caller-identity --query Arn --output text)}"
    if [[ "$principal_arn" == *:sts::*:assumed-role/* ]]; then
      role_name="${principal_arn#*:assumed-role/}"
      role_name="${role_name%%/*}"
      principal_arn="$(aws_cli iam list-roles --output json | jq -er --arg name "$role_name" '.Roles[] | select(.RoleName == $name) | .Arn')"
    fi
    apply_stack "DefaultVpcId=$vpc_id" "PublicSubnetIds=$subnets" "DeploymentPrincipalArn=$principal_arn"
    echo "Runtime secret: $(output RuntimeSecretArn)"
    echo "Vercel API_INTERNAL_URL: $(output ApiUrl)"
    ;;
  secrets)
    env_file="${2:-.env.production.local}"
    secret_file="$(mktemp)"
    trap 'rm -f "$secret_file"' EXIT
    chmod 600 "$secret_file"
    node --import tsx infra/aws/scripts/runtime-env.ts write "$env_file" "$secret_file"
    aws_cli secretsmanager put-secret-value --secret-id "$(output RuntimeSecretArn)" \
      --secret-string "file://$secret_file" --query ARN --output text
    echo "Secrets uploaded. Re-run release to apply changes to running containers."
    ;;
  publish)
    command -v docker >/dev/null
    tag="${2:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)}"
    [[ "$tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || { echo "Invalid image tag." >&2; exit 1; }
    api_repository="$(output ApiRepository)"
    worker_repository="$(output WorkerRepository)"
    aws_cli ecr get-login-password | docker login --username AWS --password-stdin "${api_repository%%/*}"
    docker buildx build --platform linux/amd64 --target api -f docker/Dockerfile -t "$api_repository:$tag" --push .
    docker buildx build --platform linux/amd64 --target worker -f docker/Dockerfile -t "$worker_repository:$tag" --push .
    echo "Published release tag: $tag"
    ;;
  stage|release)
    tag="${2:?Provide the published image tag.}"
    api_image="$(output ApiRepository):$tag"
    worker_image="$(output WorkerRepository):$tag"
    for repository in "$stack/api" "$stack/worker"; do
      aws_cli ecr describe-images --repository-name "$repository" --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text
    done
    if [[ "$1" == release ]]; then
      aws_cli secretsmanager get-secret-value --secret-id "$(output RuntimeSecretArn)" --query SecretString --output text |
        node --import tsx infra/aws/scripts/runtime-env.ts check
    fi
    # Stop application processes before migrations, including breaking migrations.
    apply_stack "ApiImage=$api_image" "WorkerImage=$worker_image" ApiCount=0 WorkerCount=0
    if [[ "$1" == stage ]]; then echo "Images staged. Services remain stopped until credentials are filled."; exit 0; fi
    cluster="$(output Cluster)"
    subnet_ids="$(output PublicSubnetIds | jq -Rc 'split(",")')"
    network="$(jq -nc --argjson subnets "$subnet_ids" --arg group "$(output WorkerSecurityGroup)" \
      '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$group],assignPublicIp:"ENABLED"}}')"
    assume_task_operations
    result="$(task_cli ecs run-task --cluster "$cluster" --launch-type FARGATE --task-definition "$(output MigrationTask)" \
      --network-configuration "$network" --started-by invookemail-migration --output json)"
    task_arn="$(printf '%s' "$result" | jq -er 'if (.failures | length) > 0 then error("ECS rejected the migration task") else .tasks[0].taskArn end')"
    task_cli ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"
    task_cli ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --output json |
      jq -e '.tasks[0].containers[0].exitCode == 0' >/dev/null || {
        echo "Migration failed. Check /$stack/migration; services remain stopped." >&2; exit 1;
      }
    apply_stack ApiCount=1 WorkerCount=1
    aws_cli ecs update-service --cluster "$cluster" --service "$stack-api" --force-new-deployment --query 'service.serviceName' --output text
    aws_cli ecs update-service --cluster "$cluster" --service "$stack-worker" --force-new-deployment --query 'service.serviceName' --output text
    aws_cli ecs wait services-stable --cluster "$cluster" --services "$stack-api" "$stack-worker"
    node --input-type=module - "$(output ApiUrl)/health/ready" <<'NODE'
import axios from './apps/api/node_modules/axios/index.js';
const response = await axios.get(process.argv[2]);
if (response.status !== 200) throw new Error('API readiness check failed.');
console.log('Production API is ready.');
NODE
    ;;
  diff)
    cdk_cli diff "$stack"
    ;;
  status)
    aws_cli cloudformation describe-stacks --stack-name "$stack" \
      --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}' --output json
    ;;
  *) echo "Usage: AWS_REGION=... AWS_PROFILE=... $0 {bootstrap|diff|secrets [env-file]|publish [tag]|stage tag|release tag|status}" >&2; exit 1 ;;
esac
