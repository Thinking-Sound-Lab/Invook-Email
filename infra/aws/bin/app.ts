import { App } from "aws-cdk-lib";

import { ProductionStack } from "../lib/production-stack";

const app = new App();
const stackName = process.env.AWS_STACK_NAME ?? "invookemail-prod";
new ProductionStack(app, stackName, {
  stackName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION,
  },
  tags: { Project: "InvookEmail", Environment: "prod" },
});
