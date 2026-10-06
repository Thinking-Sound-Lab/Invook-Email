import { CfnCondition, Fn, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";

import type { MailServices } from "./mail-services";
import type { RuntimeResources } from "./runtime-resources";

export interface TaskOperationsProps {
  principalArn: string;
  runtime: RuntimeResources;
  services: MailServices;
}

export class TaskOperations extends Construct {
  readonly role: iam.CfnRole;
  readonly isConfigured: CfnCondition;

  constructor(scope: Construct, constructId: string, props: TaskOperationsProps) {
    super(scope, constructId);
    this.isConfigured = new CfnCondition(this, "HasTaskOperations", {
      expression: Fn.conditionAnd(
        Fn.conditionNot(Fn.conditionEquals(props.principalArn, "")),
        props.services.hasWorkerImage,
      ),
    });
    this.isConfigured.overrideLogicalId("HasTaskOperations");
    this.role = new iam.CfnRole(this, "TaskOperationsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow", Action: "sts:AssumeRole",
          Principal: { AWS: Fn.sub("arn:${AWS::Partition}:iam::${AWS::AccountId}:root") },
          Condition: { ArnEquals: { "aws:PrincipalArn": props.principalArn } },
        }],
      },
      policies: [{
        policyName: "RunMigrationAndCheckApi",
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow", Action: "iam:PassRole",
              Resource: [props.runtime.executionRole.attrArn, props.runtime.apiRole.attrArn],
              Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
            },
            {
              Effect: "Allow", Action: "ecs:RunTask",
              Resource: [
                props.services.migrationTask.ref,
                Fn.conditionIf("HasApiImage", props.services.apiTask.ref, Fn.ref("AWS::NoValue")),
              ],
              Condition: { ArnEquals: { "ecs:cluster": props.runtime.cluster.attrArn } },
            },
            {
              Effect: "Allow", Action: ["ecs:DescribeTasks", "ecs:StopTask"],
              Resource: Fn.sub("arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:task/${Cluster}/*"),
            },
          ],
        },
      }],
    });
    this.role.overrideLogicalId("TaskOperationsRole");
    this.role.cfnOptions.condition = this.isConfigured;
  }
}
