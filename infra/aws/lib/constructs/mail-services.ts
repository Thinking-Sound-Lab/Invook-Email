import { CfnCondition, Fn, aws_ecs as ecs } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  API_CONFIGURATION_KEYS, API_SECRET_KEYS, WORKER_CONFIGURATION_KEYS, WORKER_SECRET_KEYS,
  type RuntimeSecretKey,
} from "../runtime-environment";
import type { ApiIngress } from "./api-ingress";
import type { RuntimeConfiguration } from "./runtime-configuration";
import type { RuntimeResources } from "./runtime-resources";

export interface MailServicesProps {
  runtime: RuntimeResources;
  configuration: RuntimeConfiguration;
  ingress: ApiIngress;
  subnetIds: string[];
  mailBucketName: string;
  apiImage: string;
  workerImage: string;
  apiCount: number;
  workerCount: number;
}

interface TaskDefinitionProps {
  logicalId: string;
  name: string;
  image: string;
  cpu: string;
  memory: string;
  executionRoleArn: string;
  taskRoleArn?: string;
  condition: CfnCondition;
  container: Omit<ecs.CfnTaskDefinition.ContainerDefinitionProperty, "name" | "image" | "essential" | "stopTimeout">;
}

function createTaskDefinition(scope: Construct, props: TaskDefinitionProps): ecs.CfnTaskDefinition {
  const task = new ecs.CfnTaskDefinition(scope, props.logicalId, {
    family: Fn.sub("${AWS::StackName}-" + props.name), cpu: props.cpu, memory: props.memory,
    networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"],
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    executionRoleArn: props.executionRoleArn, taskRoleArn: props.taskRoleArn,
    containerDefinitions: [{
      name: props.name, image: props.image, essential: true, stopTimeout: 120, ...props.container,
    }],
  });
  task.overrideLogicalId(props.logicalId);
  task.cfnOptions.condition = props.condition;
  return task;
}

function createService(
  scope: Construct, logicalId: string, props: ecs.CfnServiceProps, condition: CfnCondition,
): ecs.CfnService {
  const service = new ecs.CfnService(scope, logicalId, {
    launchType: "FARGATE",
    deploymentConfiguration: {
      deploymentCircuitBreaker: { enable: true, rollback: true },
      minimumHealthyPercent: 100, maximumPercent: 200,
    },
    ...props,
  });
  service.overrideLogicalId(logicalId);
  service.cfnOptions.condition = condition;
  return service;
}

export class MailServices extends Construct {
  readonly apiTask: ecs.CfnTaskDefinition;
  readonly migrationTask: ecs.CfnTaskDefinition;
  readonly hasWorkerImage: CfnCondition;

  constructor(scope: Construct, constructId: string, props: MailServicesProps) {
    super(scope, constructId);
    const { runtime, configuration, ingress } = props;
    const hasApiImage = new CfnCondition(this, "HasApiImage", {
      expression: Fn.conditionNot(Fn.conditionEquals(props.apiImage, "")),
    });
    hasApiImage.overrideLogicalId("HasApiImage");
    this.hasWorkerImage = new CfnCondition(this, "HasWorkerImage", {
      expression: Fn.conditionNot(Fn.conditionEquals(props.workerImage, "")),
    });
    this.hasWorkerImage.overrideLogicalId("HasWorkerImage");

    const storageEnvironment = [
      { name: "S3_ENDPOINT", value: Fn.sub("https://s3.${AWS::Region}.${AWS::URLSuffix}") },
      { name: "S3_REGION", value: Fn.ref("AWS::Region") },
      { name: "S3_BUCKET", value: props.mailBucketName },
    ];
    const secrets = (keys: readonly RuntimeSecretKey[]): ecs.CfnTaskDefinition.SecretProperty[] =>
      keys.map((name) => ({ name, valueFrom: Fn.join("", [runtime.secret.ref, ":" + name + "::"]) }));
    const logConfiguration = (group: string, prefix: string): ecs.CfnTaskDefinition.LogConfigurationProperty => ({
      logDriver: "awslogs",
      options: { "awslogs-group": group, "awslogs-region": Fn.ref("AWS::Region"), "awslogs-stream-prefix": prefix },
    });
    const apiTask = createTaskDefinition(this, {
      logicalId: "ApiTask", name: "api", image: props.apiImage, cpu: "256", memory: "512",
      executionRoleArn: runtime.executionRole.attrArn, taskRoleArn: runtime.apiRole.attrArn,
      condition: hasApiImage,
      container: {
        portMappings: [{ containerPort: 4000 }],
        environment: [
          { name: "NODE_ENV", value: "production" }, { name: "HOST", value: "0.0.0.0" },
          { name: "PORT", value: "4000" }, ...storageEnvironment,
          ...configuration.getEnvironment(API_CONFIGURATION_KEYS),
        ],
        secrets: secrets(API_SECRET_KEYS),
        healthCheck: {
          command: ["CMD", "node", "-e", "import('axios').then(({default:axios})=>axios.get('http://127.0.0.1:4000/health/ready')).catch(()=>process.exit(1))"],
          interval: 30, retries: 3, startPeriod: 60, timeout: 5,
        },
        logConfiguration: logConfiguration(runtime.apiLogs.ref, "api"),
      },
    });
    this.apiTask = apiTask;
    const workerTask = createTaskDefinition(this, {
      logicalId: "WorkerTask", name: "worker", image: props.workerImage, cpu: "512", memory: "2048",
      executionRoleArn: runtime.executionRole.attrArn, taskRoleArn: runtime.workerRole.attrArn,
      condition: this.hasWorkerImage,
      container: {
        environment: [
          { name: "NODE_ENV", value: "production" },
          { name: "TEMPORAL_TASK_QUEUE_PREFIX", value: Fn.ref("AWS::StackName") },
          { name: "GMAIL_CONTENT_CONCURRENCY", value: "5" },
          { name: "MAIL_LABEL_CONCURRENCY", value: "5" },
          { name: "MAIL_BULK_CONCURRENCY", value: "3" }, ...storageEnvironment,
          ...configuration.getEnvironment(WORKER_CONFIGURATION_KEYS),
        ],
        secrets: secrets(WORKER_SECRET_KEYS),
        logConfiguration: logConfiguration(runtime.workerLogs.ref, "worker"),
      },
    });
    this.migrationTask = createTaskDefinition(this, {
      logicalId: "MigrationTask", name: "migration", image: props.workerImage, cpu: "256", memory: "512",
      executionRoleArn: runtime.executionRole.attrArn, condition: this.hasWorkerImage,
      container: {
        workingDirectory: "/workspace/packages/database",
        command: ["node", "node_modules/drizzle-kit/bin.cjs", "migrate"],
        secrets: secrets(["DATABASE_URL"]),
        logConfiguration: logConfiguration(runtime.migrationLogs.ref, "migration"),
      },
    });
    const networkConfiguration = (group: string): ecs.CfnService.NetworkConfigurationProperty => ({
      awsvpcConfiguration: { assignPublicIp: "ENABLED", subnets: props.subnetIds, securityGroups: [group] },
    });
    const apiService = createService(this, "ApiService", {
      cluster: runtime.cluster.ref, serviceName: Fn.sub("${AWS::StackName}-api"),
      taskDefinition: apiTask.ref, desiredCount: props.apiCount, healthCheckGracePeriodSeconds: 90,
      networkConfiguration: networkConfiguration(ingress.apiSecurityGroup.ref),
      loadBalancers: [{ containerName: "api", containerPort: 4000, targetGroupArn: ingress.targetGroup.ref }],
    }, hasApiImage);
    apiService.addResourceDependency(ingress.listener);
    createService(this, "WorkerService", {
      cluster: runtime.cluster.ref, serviceName: Fn.sub("${AWS::StackName}-worker"),
      taskDefinition: workerTask.ref, desiredCount: props.workerCount,
      networkConfiguration: networkConfiguration(ingress.workerSecurityGroup.ref),
    }, this.hasWorkerImage);
  }
}
