import { CfnCondition, Fn, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";

import type { RuntimeResources } from "./runtime-resources";
import type { TaskOperations } from "./task-operations";

const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
const RELEASE_ROLE_NAME = "${AWS::StackName}-github-release";

/** The GitHub environment whose jobs may release; its protection rules gate every release. */
const RELEASE_ENVIRONMENT = "production";

/**
 * Named so the task operations trust policy can refer to it without depending
 * on this role, which itself depends on the task operations role.
 */
export function getReleaseRoleArn(): string {
  return Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/" + RELEASE_ROLE_NAME);
}

export interface ReleaseAccessProps {
  isConfigured: CfnCondition;
  repository: string;
  oidcProviderArn: string;
  runtime: RuntimeResources;
  operations: TaskOperations;
}

/**
 * Lets one GitHub repository's production environment run `deploy.sh publish`
 * and `release` with short-lived credentials. The stack update itself runs
 * through the CDK bootstrap roles, as it does for an operator.
 */
export class ReleaseAccess extends Construct {
  readonly role: iam.CfnRole;

  constructor(scope: Construct, constructId: string, props: ReleaseAccessProps) {
    super(scope, constructId);
    const createsProvider = new CfnCondition(this, "CreatesGitHubOidcProvider", {
      expression: Fn.conditionAnd(props.isConfigured, Fn.conditionEquals(props.oidcProviderArn, "")),
    });
    createsProvider.overrideLogicalId("CreatesGitHubOidcProvider");
    const provider = new iam.CfnOIDCProvider(this, "GitHubOidcProvider", {
      url: "https://" + GITHUB_OIDC_HOST, clientIdList: ["sts.amazonaws.com"],
    });
    provider.overrideLogicalId("GitHubOidcProvider");
    provider.cfnOptions.condition = createsProvider;

    const stackResource = (service: string, resource: string) =>
      Fn.sub("arn:${AWS::Partition}:" + service + ":${AWS::Region}:${AWS::AccountId}:" + resource);
    this.role = new iam.CfnRole(this, "ReleaseRole", {
      roleName: Fn.sub(RELEASE_ROLE_NAME),
      description: "GitHub Actions releases of this stack from the " + RELEASE_ENVIRONMENT + " environment.",
      maxSessionDuration: 7200,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
          Principal: {
            Federated: Fn.conditionIf(createsProvider.logicalId, provider.ref, props.oidcProviderArn),
          },
          Condition: {
            StringEquals: {
              [GITHUB_OIDC_HOST + ":aud"]: "sts.amazonaws.com",
              [GITHUB_OIDC_HOST + ":sub"]: Fn.join("", [
                "repo:", props.repository, ":environment:" + RELEASE_ENVIRONMENT,
              ]),
            },
          },
        }],
      },
      policies: [{
        policyName: "PublishAndRelease",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              // CDK deploys, publishes the template and reads context through its bootstrap roles.
              Effect: "Allow", Action: "sts:AssumeRole",
              Resource: Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-*-${AWS::AccountId}-${AWS::Region}"),
            },
            {
              Effect: "Allow", Action: "cloudformation:DescribeStacks",
              Resource: stackResource("cloudformation", "stack/${AWS::StackName}/*"),
            },
            { Effect: "Allow", Action: ["ec2:DescribeManagedPrefixLists", "ecr:GetAuthorizationToken"], Resource: "*" },
            {
              Effect: "Allow",
              Action: [
                "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
                "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
              ],
              Resource: [props.runtime.apiRepository.attrArn, props.runtime.workerRepository.attrArn],
            },
            {
              // `release` validates the deployed credentials before it stops any service.
              Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: props.runtime.secret.ref,
            },
            {
              Effect: "Allow", Action: "ecs:DescribeServices",
              Resource: stackResource("ecs", "service/${AWS::StackName}/*"),
            },
            Fn.conditionIf(props.operations.isConfigured.logicalId, {
              Effect: "Allow", Action: "sts:AssumeRole", Resource: props.operations.role.attrArn,
            }, Fn.ref("AWS::NoValue")),
          ],
        },
      }],
    });
    this.role.overrideLogicalId("ReleaseRole");
    this.role.cfnOptions.condition = props.isConfigured;
  }
}
