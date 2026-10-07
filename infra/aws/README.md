# Deploy Invook with AWS CDK and Vercel

This deploys the same application used by Docker self-hosting. The Next.js UI runs on Vercel. Fastify and the Temporal worker run as Docker containers on ECS Fargate. Better Auth stores sessions in Supabase PostgreSQL, and private S3 stores mail objects. Temporal Cloud, Google and OpenAI remain external services.

## Infrastructure layout

```text
infra/aws/
  bin/app.ts                       CDK app entry point
  lib/production-stack.ts          Parameters, constructs and stack outputs
  lib/constructs/
    mail-storage.ts                Private, encrypted, retained S3 bucket
    api-ingress.ts                 Security groups, internal ALB and streaming API Gateway
    runtime-configuration.ts       Ordinary runtime settings as stack parameters
    runtime-resources.ts           ECR, ECS cluster, IAM roles, secrets and logs
    mail-services.ts               API, worker and migration task definitions and services
    task-operations.ts             Scoped role for one-off migrations and infrastructure checks
  scripts/
    deploy.sh                      Bootstrap, configuration, image publication and release
    runtime-env.ts                 Runtime validation and stable key generation
  production.env.example           Documented API and worker variables
  cdk.json                         CDK configuration
```

The layout follows the app/stack/construct pattern in the [AWS CDK examples](https://github.com/aws-samples/aws-cdk-examples) and [AWS code organization guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/best-practices-cdk-typescript-iac/organizing-code-best-practices.html). Tests are colocated to match Invook's repository conventions. CloudFormation logical IDs are explicit so existing resources survive refactoring. API Gateway deployment IDs also include a configuration hash so integration changes are actually deployed.

There is one production stack, `invookemail-prod`, with no AWS dev stack. Override `AWS_STACK_NAME` when self-hosting another installation. AWS CDK lives in its own pnpm workspace package and is excluded from application container dependencies.

## Prerequisites

- Node.js 22+, the repository's pinned pnpm, Docker Buildx, AWS CLI v2 and `jq`.
- An AWS account and region with a default VPC and at least two default public subnets whose routes reach an internet gateway.
- AWS permissions to deploy CloudFormation and use its CDK bootstrap roles. The first deployment in a new account needs permission to bootstrap CDK, including IAM role creation. An existing `CDKToolkit` is reused. The helper identifies the calling IAM role/user and grants it a scoped task operations role; `release` assumes that role to run migrations. This works with PowerUser SSO profiles that cannot directly pass ECS IAM roles. Set `AWS_DEPLOYMENT_PRINCIPAL_ARN` explicitly if your caller cannot list IAM roles.
- A Vercel account, a Supabase PostgreSQL project, a Temporal Cloud production namespace, Google OAuth/Pub/Sub configuration, and OpenAI credentials.

```bash
corepack enable
pnpm install --frozen-lockfile
export AWS_PROFILE=your-aws-profile
export AWS_REGION=ap-south-1
aws sso login --profile "$AWS_PROFILE"  # When the profile uses SSO.
./infra/aws/scripts/deploy.sh bootstrap
./infra/aws/scripts/deploy.sh diff
```

`bootstrap` validates and reuses the default VPC. It creates the CDK-managed S3 bucket, image repositories, runtime secret, logs, IAM roles, ECS cluster, API Gateway, VPC link, and internal load balancer. Services are stopped until credentials and images are ready. Run bootstrap again if changing the IAM principal used for deployments.

Fargate tasks receive public IPs for outgoing connections to Supabase, Temporal Cloud and providers, avoiding NAT gateway charges. API task ingress is limited to the internal load balancer. Worker and migration tasks have no incoming ports. S3 requests use short-lived ECS IAM role credentials; no static AWS keys belong in the production env file. Infrastructure such as the ALB can incur charges while services are stopped.

## Deploy the UI on Vercel

Import the repository into Vercel with root directory `apps/web` and files outside that directory enabled. Select Next.js, Node.js 24, build command `pnpm run build`, and install command `pnpm install --frozen-lockfile`. Set these production variables:

| Variable | Value |
| --- | --- |
| `API_INTERNAL_URL` | `ApiUrl` from the AWS stack outputs, including `/prod` |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1`, to use the pinned pnpm version |

Deploy using the Vercel UI or the CLI:

```bash
pnpm dlx vercel link
pnpm dlx vercel deploy --prod
```

Use the stable production `*.vercel.app` alias for `APP_URL`, rather than the URL of one build. Requests, Google callbacks and SSE use that origin through the Next.js proxies. The AWS-generated `ApiUrl` supplies HTTPS without requiring a custom API domain. API Gateway streams responses through its private ALB integration; SSE handlers on Vercel have a 300-second maximum duration and browsers reconnect when a stream closes.

Vercel deployments can finish before the API is activated, but the application cannot serve sessions or mail until the AWS API is running.

## Configure production services

```bash
cp infra/aws/production.env.example .env.production.local
chmod 600 .env.production.local
```

Fill the documented variables in that ignored file. Do not commit it or share credentials in issues. `configure` generates and persists independent `BETTER_AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` values when empty. Keep a secure backup of the encryption key: replacing it makes existing Google grants unreadable.

```bash
./infra/aws/scripts/deploy.sh configure
```

The single env file is the setup input. Ordinary settings go into CloudFormation parameters and ECS `environment`; credentials go into one Secrets Manager JSON secret named `<AWS_STACK_NAME>/runtime` and ECS `secrets`. Each container receives only the variables it uses. CloudFormation manages the secret resource, without storing or resetting its value in the template. No automatic rotation is configured.

| Ordinary settings | Sensitive values |
| --- | --- |
| `APP_URL` | `DATABASE_URL` |
| `BETTER_AUTH_GOOGLE_CLIENT_ID`, `GMAIL_GOOGLE_CLIENT_ID` | `BETTER_AUTH_GOOGLE_CLIENT_SECRET`, `GMAIL_GOOGLE_CLIENT_SECRET` |
| `GMAIL_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_SUBSCRIPTION` | `BETTER_AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| `GOOGLE_PUBSUB_PUSH_AUDIENCE`, `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL` | `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET` |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` | `TEMPORAL_API_KEY` |

`configure` stops API and worker before applying settings and credentials together. It can prepare incomplete configuration; services stay stopped until `release` validates the deployed CloudFormation parameters and secret. To update a value, edit the same env file, run `configure`, then `release`. Preserve the existing auth and encryption keys when updating provider credentials. Vercel gets only the API origin; database, OAuth, Temporal and OpenAI credentials stay on AWS.

For Supabase, copy the **session pooler** PostgreSQL connection string from the project's Connect dialog, using port **5432** and `sslmode=verify-full`. This deployment uses IPv4 subnets. A direct Supabase connection requires the project's IPv4 support; the default direct IPv6 address will not work here. Transaction pooling on port 6543 breaks the persistent connections required by `LISTEN` and session advisory locks. Invook uses SQL migrations and Better Auth, so no Supabase Auth or Storage setup is required. Create a fresh production database, or back up existing data before applying this repository's migrations.

For Temporal Cloud, set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_API_KEY` from the production namespace and a scoped API key. Use production values, not a developer namespace. The stack supplies `TEMPORAL_TASK_QUEUE_PREFIX` to isolate the installation's task queues.

Configure the external callbacks using the deployed origins:

- Better Auth Google redirect: `<APP_URL>/v1/auth/callback/google`.
- Gmail OAuth redirect: `<APP_URL>/connections/gmail/callback`.
- Gmail Pub/Sub push endpoint: `<ApiUrl>/v1/webhooks/google-pubsub`. Set its authenticated push audience to `GOOGLE_PUBSUB_PUSH_AUDIENCE` and its service account to `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`.
- OpenAI Batch webhook endpoint: `<ApiUrl>/v1/webhooks/openai`. Copy the signing secret to `OPENAI_WEBHOOK_SECRET`.

Google OAuth consent and Gmail scopes, Pub/Sub push authentication, and provider webhook registration are configured outside CDK.

## Publish and activate

```bash
./infra/aws/scripts/deploy.sh publish release-tag
./infra/aws/scripts/deploy.sh stage release-tag   # Optional: install images with zero running tasks.
./infra/aws/scripts/deploy.sh release release-tag
./infra/aws/scripts/deploy.sh status
```

Images use immutable ECR tags and Linux amd64. Use a new tag for each build. `release` checks the deployed settings, secret and images, stops API and worker, runs the migration task, checks its exit code, starts both services, and checks API readiness. It intentionally permits downtime while migrations run, including breaking migrations. If migration fails, services stay stopped and the migration log group contains diagnostics. Changes made directly in Secrets Manager apply to containers after another `release`; keep the ignored setup file synchronized before the next `configure`.

Logs are under `/<AWS_STACK_NAME>/api`, `/worker`, and `/migration`, with 14-day retention. S3 and the runtime secret are retained if the CDK stack is deleted. Delete those explicitly only when intentionally removing all installation data. Tagged container releases remain available for rollback; returning to an older image does not undo database migrations.

## Verification

```bash
pnpm --filter @invook/infra typecheck
pnpm --filter @invook/infra test
pnpm --filter @invook/infra cdk synth --quiet
./infra/aws/scripts/deploy.sh diff
make verify
docker compose -f docker/compose.yml config --quiet
```

Before accepting production, verify `/health/ready`, Google sign-in, Gmail connection and push delivery, Temporal task execution, S3 attachments, OpenAI webhooks, and SSE updates with your real production credentials. Successful infrastructure deployment alone does not verify these integrations.
