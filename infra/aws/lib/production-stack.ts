import { CfnCondition, CfnOutput, CfnParameter, Fn, Stack, Token, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";

import { ApiIngress } from "./constructs/api-ingress";
import { MailServices } from "./constructs/mail-services";
import { MailStorage } from "./constructs/mail-storage";
import { getReleaseRoleArn, ReleaseAccess } from "./constructs/release-access";
import { RuntimeConfiguration } from "./constructs/runtime-configuration";
import { RuntimeResources } from "./constructs/runtime-resources";
import { TaskOperations } from "./constructs/task-operations";

export class ProductionStack extends Stack {
  constructor(scope: Construct, constructId: string, props: StackProps = {}) {
    super(scope, constructId, props);
    this.templateOptions.description = "Invook Email production API and Temporal worker in an existing default VPC.";
    const vpcId = new CfnParameter(this, "DefaultVpcId", { type: "AWS::EC2::VPC::Id" });
    const subnetIds = new CfnParameter(this, "PublicSubnetIds", { type: "List<AWS::EC2::Subnet::Id>" });
    const apiImage = new CfnParameter(this, "ApiImage", { type: "String", default: "" });
    const workerImage = new CfnParameter(this, "WorkerImage", { type: "String", default: "" });
    const apiCount = new CfnParameter(this, "ApiCount", { type: "Number", default: 0, minValue: 0, maxValue: 4 });
    const workerCount = new CfnParameter(this, "WorkerCount", { type: "Number", default: 0, minValue: 0, maxValue: 4 });
    const deploymentPrincipalArn = new CfnParameter(this, "DeploymentPrincipalArn", {
      type: "String", default: "",
      description: "IAM role or user allowed to assume the scoped ECS task operations role.",
      allowedPattern: "^$|^arn:[a-z0-9-]+:iam::[0-9]{12}:(role/.+|user/.+|root)$",
    });
    const originFacingPrefixListId = new CfnParameter(this, "CloudFrontOriginFacingPrefixListId", {
      type: "String", allowedPattern: "^pl-[0-9a-f]+$",
      description: "Regional ID of the com.amazonaws.global.cloudfront.origin-facing managed prefix list.",
    });
    const releaseRepository = new CfnParameter(this, "ReleaseRepository", {
      type: "String", default: "",
      description: "GitHub repository whose aws-production environment may release this stack, as its OIDC subject names it: "
        + "owner/name, or owner@id/name@id for immutable subjects. Empty disables it.",
      allowedPattern: "^$|^[A-Za-z0-9_.-]+(@[0-9]+)?/[A-Za-z0-9_.-]+(@[0-9]+)?$",
    });
    const gitHubOidcProviderArn = new CfnParameter(this, "GitHubOidcProviderArn", {
      type: "String", default: "",
      description: "The account's existing GitHub Actions OIDC provider. Empty creates one.",
      allowedPattern: "^$|^arn:[a-z0-9-]+:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$",
    });
    for (const parameter of [
      vpcId, subnetIds, apiImage, workerImage, apiCount, workerCount, deploymentPrincipalArn, originFacingPrefixListId,
      releaseRepository, gitHubOidcProviderArn,
    ]) {
      parameter.overrideLogicalId(parameter.node.id);
    }
    const hasReleaseAccess = new CfnCondition(this, "HasReleaseAccess", {
      expression: Fn.conditionNot(Fn.conditionEquals(releaseRepository.valueAsString, "")),
    });
    hasReleaseAccess.overrideLogicalId("HasReleaseAccess");

    const storage = new MailStorage(this, "Storage");
    const ingress = new ApiIngress(this, "Ingress", {
      vpcId: vpcId.valueAsString, subnetIds: subnetIds.valueAsList,
      cloudFrontOriginFacingPrefixListId: originFacingPrefixListId.valueAsString,
    });
    const runtime = new RuntimeResources(this, "Runtime", { mailBucketArn: storage.bucket.attrArn });
    const configuration = new RuntimeConfiguration(this, "Configuration");
    const services = new MailServices(this, "Services", {
      runtime, configuration, ingress, subnetIds: subnetIds.valueAsList, mailBucketName: storage.bucket.ref,
      apiImage: apiImage.valueAsString, workerImage: workerImage.valueAsString,
      apiCount: apiCount.valueAsNumber, workerCount: workerCount.valueAsNumber,
    });
    const operations = new TaskOperations(this, "TaskOperations", {
      principalArn: deploymentPrincipalArn.valueAsString,
      releasePrincipalArn: Token.asString(
        Fn.conditionIf(hasReleaseAccess.logicalId, getReleaseRoleArn(), Fn.ref("AWS::NoValue")),
      ),
      runtime, services,
    });
    const release = new ReleaseAccess(this, "ReleaseAccess", {
      isConfigured: hasReleaseAccess, repository: releaseRepository.valueAsString,
      oidcProviderArn: gitHubOidcProviderArn.valueAsString, runtime, operations,
    });

    const outputs = {
      ApiUrl: ingress.apiUrl,
      AgentSocketUrl: ingress.agentSocketUrl,
      ApiRepository: runtime.apiRepository.attrRepositoryUri,
      WorkerRepository: runtime.workerRepository.attrRepositoryUri,
      MailBucket: storage.bucket.ref,
      RuntimeSecretArn: runtime.secret.ref,
      Cluster: runtime.cluster.ref,
      DefaultVpcId: vpcId.valueAsString,
      PublicSubnetIds: Fn.join(",", subnetIds.valueAsList),
      WorkerSecurityGroup: ingress.workerSecurityGroup.ref,
    };
    for (const [logicalId, value] of Object.entries(outputs)) {
      const output = new CfnOutput(this, logicalId + "Output", { value });
      output.overrideLogicalId(logicalId);
    }
    const migrationOutput = new CfnOutput(this, "MigrationTaskOutput", {
      value: services.migrationTask.ref, condition: services.hasWorkerImage,
    });
    migrationOutput.overrideLogicalId("MigrationTask");
    const operationsOutput = new CfnOutput(this, "TaskOperationsRoleArnOutput", {
      value: operations.role.attrArn, condition: operations.isConfigured,
    });
    operationsOutput.overrideLogicalId("TaskOperationsRoleArn");
    const releaseOutput = new CfnOutput(this, "ReleaseRoleArnOutput", {
      value: release.role.attrArn, condition: hasReleaseAccess,
    });
    releaseOutput.overrideLogicalId("ReleaseRoleArn");
  }
}
