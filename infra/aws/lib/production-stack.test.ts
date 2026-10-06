import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseEnv } from "node:util";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

import { ProductionStack } from "./production-stack";
import { API_RUNTIME_KEYS, RUNTIME_KEYS, WORKER_RUNTIME_KEYS } from "./runtime-environment";

function createTemplate(): Template {
  return Template.fromStack(new ProductionStack(new App(), "invookemail-prod"));
}

test("production imports a VPC, starts stopped, and isolates task ingress", () => {
  const template = createTemplate();
  for (const resourceType of ["AWS::EC2::VPC", "AWS::EC2::NatGateway", "AWS::RDS::DBInstance"]) {
    template.resourceCountIs(resourceType, 0);
  }
  template.hasParameter("ApiCount", { Default: 0 });
  template.hasParameter("WorkerCount", { Default: 0 });
  template.hasResourceProperties("AWS::EC2::SecurityGroup", {
    GroupDescription: "Worker and migration tasks. No inbound access.",
    VpcId: { Ref: "DefaultVpcId" }, SecurityGroupIngress: Match.absent(),
  });
  template.hasResourceProperties("AWS::EC2::SecurityGroup", {
    GroupDescription: "API tasks accept only load balancer traffic.",
    SecurityGroupIngress: [{
      IpProtocol: "tcp", FromPort: 4000, ToPort: 4000,
      SourceSecurityGroupId: { Ref: "LoadBalancerSecurityGroup" },
    }],
  });
  template.hasResourceProperties("AWS::ECS::Service", {
    DesiredCount: { Ref: "ApiCount" },
    NetworkConfiguration: { AwsvpcConfiguration: {
      AssignPublicIp: "ENABLED", Subnets: { Ref: "PublicSubnetIds" }, SecurityGroups: [{ Ref: "ApiSecurityGroup" }],
    } },
  });
});

test("mail stays private and retained, and API storage permissions are read-only", () => {
  const template = createTemplate();
  template.hasResource("AWS::S3::Bucket", {
    DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
    Properties: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
    },
  });
  template.hasResourceProperties("AWS::IAM::Role", {
    Policies: [{ PolicyName: "ReadMailObjects", PolicyDocument: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: { "Fn::Sub": "${MailBucket.Arn}/*" } }],
    } }],
  });
  template.hasResource("AWS::SecretsManager::Secret", { DeletionPolicy: "Retain" });
});

test("gateway streams SSE and maps the application path to its private ALB", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    Integration: {
      Type: "HTTP_PROXY", ConnectionType: "VPC_LINK", ResponseTransferMode: "STREAM", TimeoutInMillis: 900000,
      IntegrationTarget: { Ref: "LoadBalancer" },
      RequestParameters: { "integration.request.path.proxy": "method.request.path.proxy" },
    },
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", { Scheme: "internal" });
  const deployments = Object.keys(template.findResources("AWS::ApiGateway::Deployment"));
  assert.equal(deployments.length, 1);
  assert.match(deployments[0], /^ApiDeployment[a-f0-9]{12}$/);
  assert.deepEqual(deployments, Object.keys(createTemplate().findResources("AWS::ApiGateway::Deployment")));
});

test("runtime template and ECS secret bindings agree without static AWS keys", () => {
  const template = createTemplate();
  const environment = parseEnv(readFileSync(new URL("../production.env.example", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(environment).sort(), [...RUNTIME_KEYS].sort());
  for (const [name, keys] of [["api", API_RUNTIME_KEYS], ["worker", WORKER_RUNTIME_KEYS]] as const) {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [Match.objectLike({
        Name: name, Secrets: keys.map((key) => ({
          Name: key, ValueFrom: { "Fn::Join": ["", [{ Ref: "RuntimeSecret" }, ":" + key + "::"]] },
        })),
        Environment: Match.not(Match.arrayWith([{ Name: "S3_ACCESS_KEY_ID", Value: Match.anyValue() }])),
      })],
    });
  }
});

test("one-off task operations trust only the configured deployer and scoped ECS roles", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::IAM::Role", {
    AssumeRolePolicyDocument: {
      Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "sts:AssumeRole",
        Principal: { AWS: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:root" } },
        Condition: { ArnEquals: { "aws:PrincipalArn": { Ref: "DeploymentPrincipalArn" } } },
      }],
    },
    Policies: [{
      PolicyName: "RunMigrationAndCheckApi",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: Match.arrayWith([{
          Effect: "Allow", Action: "iam:PassRole",
          Resource: [{ "Fn::GetAtt": ["ExecutionRole", "Arn"] }, { "Fn::GetAtt": ["ApiRole", "Arn"] }],
          Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
        }]),
      },
    }],
  });
});
