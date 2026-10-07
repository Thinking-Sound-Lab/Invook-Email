import {
  Fn, RemovalPolicy, aws_ecr as ecr, aws_ecs as ecs,
  aws_iam as iam, aws_logs as logs, aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface RuntimeResourcesProps {
  mailBucketArn: string;
}

function createRepository(scope: Construct, logicalId: string, name: string): ecr.CfnRepository {
  const repository = new ecr.CfnRepository(scope, logicalId, {
    repositoryName: Fn.sub("${AWS::StackName}/" + name),
    imageTagMutability: "IMMUTABLE", imageScanningConfiguration: { scanOnPush: true },
    lifecyclePolicy: {
      lifecyclePolicyText: JSON.stringify({ rules: [{
        rulePriority: 1, description: "Remove untagged build layers after seven days",
        selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 7 },
        action: { type: "expire" },
      }] }),
    },
  });
  repository.overrideLogicalId(logicalId);
  return repository;
}

function createLogGroup(scope: Construct, logicalId: string, name: string): logs.CfnLogGroup {
  const logGroup = new logs.CfnLogGroup(scope, logicalId, {
    logGroupName: Fn.sub("/${AWS::StackName}/" + name), retentionInDays: 14,
  });
  logGroup.overrideLogicalId(logicalId);
  return logGroup;
}

function createTaskRole(scope: Construct, logicalId: string, policies: iam.CfnRole.PolicyProperty[]): iam.CfnRole {
  const role = new iam.CfnRole(scope, logicalId, {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": Fn.ref("AWS::AccountId") },
          ArnLike: { "aws:SourceArn": Fn.sub("arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:*") },
        },
      }],
    },
    policies,
  });
  role.overrideLogicalId(logicalId);
  return role;
}

export class RuntimeResources extends Construct {
  readonly apiRepository: ecr.CfnRepository;
  readonly workerRepository: ecr.CfnRepository;
  readonly secret: secretsmanager.CfnSecret;
  readonly cluster: ecs.CfnCluster;
  readonly apiLogs: logs.CfnLogGroup;
  readonly workerLogs: logs.CfnLogGroup;
  readonly migrationLogs: logs.CfnLogGroup;
  readonly executionRole: iam.CfnRole;
  readonly apiRole: iam.CfnRole;
  readonly workerRole: iam.CfnRole;

  constructor(scope: Construct, constructId: string, props: RuntimeResourcesProps) {
    super(scope, constructId);
    this.apiRepository = createRepository(this, "ApiRepository", "api");
    this.workerRepository = createRepository(this, "WorkerRepository", "worker");
    this.secret = new secretsmanager.CfnSecret(this, "RuntimeSecret", {
      name: Fn.sub("${AWS::StackName}/runtime"),
      description: "Production credentials only. Configure before activating API and worker.",
    });
    this.secret.overrideLogicalId("RuntimeSecret");
    this.secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.apiLogs = createLogGroup(this, "ApiLogs", "api");
    this.workerLogs = createLogGroup(this, "WorkerLogs", "worker");
    this.migrationLogs = createLogGroup(this, "MigrationLogs", "migration");
    this.cluster = new ecs.CfnCluster(this, "Cluster", { clusterName: Fn.ref("AWS::StackName") });
    this.cluster.overrideLogicalId("Cluster");
    this.executionRole = createTaskRole(this, "ExecutionRole", [{
      policyName: "PullImagesWriteLogsReadRuntime",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
          {
            Effect: "Allow",
            Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
            Resource: [this.apiRepository.attrArn, this.workerRepository.attrArn],
          },
          {
            Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: [this.apiLogs.attrArn, this.workerLogs.attrArn, this.migrationLogs.attrArn],
          },
          { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: this.secret.ref },
        ],
      },
    }]);
    this.apiRole = createTaskRole(this, "ApiRole", [{
      policyName: "ReadMailObjects",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow", Action: "s3:GetObject", Resource: Fn.sub("${MailBucket.Arn}/*"),
        }],
      },
    }]);
    this.workerRole = createTaskRole(this, "WorkerRole", [{
      policyName: "StoreMailObjects",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: Fn.join("", [props.mailBucketArn, "/*"]),
        }],
      },
    }]);
  }
}
