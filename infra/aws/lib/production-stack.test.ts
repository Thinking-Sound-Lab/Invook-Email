import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseEnv } from "node:util";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

import { ProductionStack } from "./production-stack";
import {
  API_CONFIGURATION_KEYS, API_SECRET_KEYS, CONFIGURATION_DEFAULTS, CONFIGURATION_KEYS, CONFIGURATION_PARAMETER_NAMES,
  RUNTIME_KEYS, SECRET_KEYS, WORKER_CONFIGURATION_KEYS, WORKER_SECRET_KEYS,
} from "./runtime-environment";

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

test("ordinary settings and secrets are complete, disjoint and bound to the intended containers", () => {
  const template = createTemplate();
  const environment = parseEnv(readFileSync(new URL("../production.env.example", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(environment).sort(), [...RUNTIME_KEYS].sort());
  assert.equal(CONFIGURATION_KEYS.length, 12);
  assert.equal(SECRET_KEYS.length, 8);
  assert.equal(new Set(RUNTIME_KEYS).size, RUNTIME_KEYS.length);
  for (const key of CONFIGURATION_KEYS) template.hasParameter(CONFIGURATION_PARAMETER_NAMES[key], { Default: CONFIGURATION_DEFAULTS[key] ?? "" });
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    SecretString: Match.absent(), GenerateSecretString: Match.absent(),
  });
  for (const [name, settings, secrets] of [
    ["api", API_CONFIGURATION_KEYS, API_SECRET_KEYS],
    ["worker", WORKER_CONFIGURATION_KEYS, WORKER_SECRET_KEYS],
  ] as const) {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: [Match.objectLike({
        Name: name, Secrets: secrets.map((key) => ({
          Name: key, ValueFrom: { "Fn::Join": ["", [{ Ref: "RuntimeSecret" }, ":" + key + "::"]] },
        })),
        Environment: Match.arrayWith(settings.map((key) => ({
          Name: key, Value: { Ref: CONFIGURATION_PARAMETER_NAMES[key] },
        }))),
      })],
    });
    for (const key of [...SECRET_KEYS, "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        ContainerDefinitions: [Match.objectLike({
          Name: name, Environment: Match.not(Match.arrayWith([{ Name: key, Value: Match.anyValue() }])),
        })],
      });
    }
  }
});

test("one-off task operations trust only the configured deployer and scoped ECS roles", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::IAM::Role", {
    AssumeRolePolicyDocument: {
      Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "sts:AssumeRole",
        Principal: { AWS: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:root" } },
        Condition: { ArnEquals: { "aws:PrincipalArn": [
          { Ref: "DeploymentPrincipalArn" },
          { "Fn::If": ["HasReleaseAccess", { "Fn::Sub": releaseRoleArn }, { Ref: "AWS::NoValue" }] },
        ] } },
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

const releaseRoleArn = "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${AWS::StackName}-github-release";

test("GitHub releases are off until a repository is set, and then only its aws-production environment may release", () => {
  const template = createTemplate();
  template.hasParameter("ReleaseRepository", { Default: "" });
  // GitHub names a repository with immutable OIDC subjects by owner and repository ID.
  const repositoryPattern = new RegExp(template.toJSON().Parameters.ReleaseRepository.AllowedPattern);
  for (const repository of ["", "Thinking-Sound-Lab/Invook-Email", "Thinking-Sound-Lab@230501294/Invook-Email@1328790913"]) {
    assert.match(repository, repositoryPattern);
  }
  for (const repository of ["Invook-Email", "owner/name:environment:x", "owner@id/name"]) {
    assert.doesNotMatch(repository, repositoryPattern);
  }
  template.hasParameter("GitHubOidcProviderArn", { Default: "" });
  template.hasCondition("HasReleaseAccess", { "Fn::Not": [{ "Fn::Equals": [{ Ref: "ReleaseRepository" }, ""] }] });
  // An account that already trusts GitHub reuses its provider.
  template.hasCondition("CreatesGitHubOidcProvider", {
    "Fn::And": [{ Condition: "HasReleaseAccess" }, { "Fn::Equals": [{ Ref: "GitHubOidcProviderArn" }, ""] }],
  });
  template.hasResource("AWS::IAM::OIDCProvider", {
    Condition: "CreatesGitHubOidcProvider",
    Properties: { Url: "https://token.actions.githubusercontent.com", ClientIdList: ["sts.amazonaws.com"] },
  });
  template.hasResource("AWS::IAM::Role", {
    Condition: "HasReleaseAccess",
    Properties: Match.objectLike({
      RoleName: { "Fn::Sub": "${AWS::StackName}-github-release" },
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
          Principal: { Federated: { "Fn::If": [
            "CreatesGitHubOidcProvider", { Ref: "GitHubOidcProvider" }, { Ref: "GitHubOidcProviderArn" },
          ] } },
          Condition: { StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": {
              "Fn::Join": ["", ["repo:", { Ref: "ReleaseRepository" }, ":environment:aws-production"]],
            },
          } },
        }],
      },
    }),
  });
  template.hasOutput("ReleaseRoleArn", { Condition: "HasReleaseAccess", Value: { "Fn::GetAtt": ["ReleaseRole", "Arn"] } });
});

test("the release role reaches only this stack's images, secret, services and task operations", () => {
  const template = createTemplate();
  template.hasResourceProperties("AWS::IAM::Role", {
    Policies: [{
      PolicyName: "PublishAndRelease",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow", Action: "sts:AssumeRole",
            Resource: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-*-${AWS::AccountId}-${AWS::Region}" },
          },
          {
            Effect: "Allow", Action: "cloudformation:DescribeStacks",
            Resource: { "Fn::Sub": "arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${AWS::StackName}/*" },
          },
          { Effect: "Allow", Action: ["ec2:DescribeManagedPrefixLists", "ecr:GetAuthorizationToken"], Resource: "*" },
          Match.objectLike({
            Action: Match.arrayWith(["ecr:DescribeImages", "ecr:PutImage"]),
            Resource: [{ "Fn::GetAtt": ["ApiRepository", "Arn"] }, { "Fn::GetAtt": ["WorkerRepository", "Arn"] }],
          }),
          { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { Ref: "RuntimeSecret" } },
          {
            Effect: "Allow", Action: "ecs:DescribeServices",
            Resource: { "Fn::Sub": "arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:service/${AWS::StackName}/*" },
          },
          { "Fn::If": [
            "HasTaskOperations",
            { Effect: "Allow", Action: "sts:AssumeRole", Resource: { "Fn::GetAtt": ["TaskOperationsRole", "Arn"] } },
            { Ref: "AWS::NoValue" },
          ] },
        ],
      },
    }],
  });
});

test("the agent socket reaches the private ALB only through CloudFront on its own path", () => {
  const template = createTemplate();
  template.hasParameter("CloudFrontOriginFacingPrefixListId", { AllowedPattern: "^pl-[0-9a-f]+$" });
  template.hasResourceProperties("AWS::EC2::SecurityGroup", {
    GroupDescription: "Internal load balancer reachable only from the API Gateway VPC link.",
    SecurityGroupIngress: [
      Match.objectLike({ FromPort: 80, SourceSecurityGroupId: { Ref: "VpcLinkSecurityGroup" } }),
      Match.objectLike({
        IpProtocol: "tcp", FromPort: 80, ToPort: 80,
        SourcePrefixListId: { Ref: "CloudFrontOriginFacingPrefixListId" },
      }),
    ],
  });
  template.hasResourceProperties("AWS::CloudFront::VpcOrigin", {
    VpcOriginEndpointConfig: Match.objectLike({
      Arn: { Ref: "LoadBalancer" }, HTTPPort: 80, OriginProtocolPolicy: "http-only",
    }),
  });
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      HttpVersion: "http1.1",
      Origins: [Match.objectLike({
        DomainName: { "Fn::GetAtt": ["LoadBalancer", "DNSName"] },
        VpcOriginConfig: { VpcOriginId: { "Fn::GetAtt": ["AgentSocketVpcOrigin", "Id"] } },
      })],
      // Everything but the socket path is refused at the edge.
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: "https-only",
        FunctionAssociations: [{
          EventType: "viewer-request",
          FunctionARN: { "Fn::GetAtt": ["AgentSocketNotFound", "FunctionARN"] },
        }],
      }),
      CacheBehaviors: [Match.objectLike({
        PathPattern: "/v1/agent/socket", ViewerProtocolPolicy: "https-only",
        AllowedMethods: ["GET", "HEAD"],
        CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        OriginRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3",
      })],
    }),
  });
  const socketUrl = {
    "Fn::Join": ["", ["wss://", { "Fn::GetAtt": ["AgentSocketDistribution", "DomainName"] }, "/v1/agent/socket"]],
  };
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: [Match.objectLike({
      Name: "api", Environment: Match.arrayWith([{ Name: "AGENT_SOCKET_URL", Value: socketUrl }]),
    })],
  });
  template.hasOutput("AgentSocketUrl", { Value: socketUrl });
});
