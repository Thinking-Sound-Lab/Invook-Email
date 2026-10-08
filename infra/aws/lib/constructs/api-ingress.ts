import { createHash } from "node:crypto";

import {
  Fn, Stack, aws_apigateway as apigateway, aws_apigatewayv2 as apigatewayv2,
  aws_ec2 as ec2, aws_elasticloadbalancingv2 as elbv2,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface ApiIngressProps {
  vpcId: string;
  subnetIds: string[];
}

export class ApiIngress extends Construct {
  readonly apiSecurityGroup: ec2.CfnSecurityGroup;
  readonly workerSecurityGroup: ec2.CfnSecurityGroup;
  readonly targetGroup: elbv2.CfnTargetGroup;
  readonly listener: elbv2.CfnListener;
  readonly apiUrl: string;

  constructor(scope: Construct, constructId: string, props: ApiIngressProps) {
    super(scope, constructId);
    const vpcLinkSecurityGroup = new ec2.CfnSecurityGroup(this, "VpcLinkSecurityGroup", {
      groupDescription: "Private API Gateway VPC link interfaces. No inbound access.",
      vpcId: props.vpcId,
      securityGroupEgress: [{ ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIp: "0.0.0.0/0" }],
    });
    vpcLinkSecurityGroup.overrideLogicalId("VpcLinkSecurityGroup");
    const loadBalancerSecurityGroup = new ec2.CfnSecurityGroup(this, "LoadBalancerSecurityGroup", {
      groupDescription: "Internal load balancer reachable only from the API Gateway VPC link.",
      vpcId: props.vpcId,
      securityGroupIngress: [{
        ipProtocol: "tcp", fromPort: 80, toPort: 80, sourceSecurityGroupId: vpcLinkSecurityGroup.ref,
      }],
      securityGroupEgress: [{ ipProtocol: "tcp", fromPort: 4000, toPort: 4000, cidrIp: "0.0.0.0/0" }],
    });
    loadBalancerSecurityGroup.overrideLogicalId("LoadBalancerSecurityGroup");
    this.apiSecurityGroup = new ec2.CfnSecurityGroup(this, "ApiSecurityGroup", {
      groupDescription: "API tasks accept only load balancer traffic.",
      vpcId: props.vpcId,
      securityGroupIngress: [{
        ipProtocol: "tcp", fromPort: 4000, toPort: 4000,
        sourceSecurityGroupId: loadBalancerSecurityGroup.ref,
      }],
    });
    this.apiSecurityGroup.overrideLogicalId("ApiSecurityGroup");
    this.workerSecurityGroup = new ec2.CfnSecurityGroup(this, "WorkerSecurityGroup", {
      groupDescription: "Worker and migration tasks. No inbound access.", vpcId: props.vpcId,
    });
    this.workerSecurityGroup.overrideLogicalId("WorkerSecurityGroup");

    const loadBalancer = new elbv2.CfnLoadBalancer(this, "LoadBalancer", {
      type: "application", scheme: "internal", subnets: props.subnetIds,
      securityGroups: [loadBalancerSecurityGroup.ref],
      loadBalancerAttributes: [{ key: "idle_timeout.timeout_seconds", value: "300" }],
    });
    loadBalancer.overrideLogicalId("LoadBalancer");
    this.targetGroup = new elbv2.CfnTargetGroup(this, "TargetGroup", {
      vpcId: props.vpcId, protocol: "HTTP", port: 4000, targetType: "ip",
      healthCheckPath: "/health/ready", healthCheckIntervalSeconds: 30,
      healthyThresholdCount: 2, unhealthyThresholdCount: 3,
      targetGroupAttributes: [{ key: "deregistration_delay.timeout_seconds", value: "30" }],
    });
    this.targetGroup.overrideLogicalId("TargetGroup");
    this.listener = new elbv2.CfnListener(this, "Listener", {
      loadBalancerArn: loadBalancer.ref, protocol: "HTTP", port: 80,
      defaultActions: [{ type: "forward", targetGroupArn: this.targetGroup.ref }],
    });
    this.listener.overrideLogicalId("Listener");
    const vpcLink = new apigatewayv2.CfnVpcLink(this, "VpcLink", {
      name: Fn.ref("AWS::StackName"), subnetIds: props.subnetIds,
      securityGroupIds: [vpcLinkSecurityGroup.ref],
    });
    vpcLink.overrideLogicalId("VpcLink");
    const restApi = new apigateway.CfnRestApi(this, "RestApi", {
      name: Fn.ref("AWS::StackName"), endpointConfiguration: { types: ["REGIONAL"] },
    });
    restApi.overrideLogicalId("RestApi");
    const proxyResource = new apigateway.CfnResource(this, "ProxyResource", {
      restApiId: restApi.ref, parentId: restApi.attrRootResourceId, pathPart: "{proxy+}",
    });
    proxyResource.overrideLogicalId("ProxyResource");

    // Streaming keeps SSE off API Gateway's buffered request execution path.
    const integration = {
      type: "HTTP_PROXY", integrationHttpMethod: "ANY", connectionType: "VPC_LINK",
      connectionId: vpcLink.ref, integrationTarget: loadBalancer.ref,
      uri: Fn.sub("http://${LoadBalancer.DNSName}/{proxy}"),
      requestParameters: { "integration.request.path.proxy": "method.request.path.proxy" },
      responseTransferMode: "STREAM", timeoutInMillis: 900000,
    } satisfies apigateway.CfnMethod.IntegrationProperty;
    const methodProps = {
      restApiId: restApi.ref, resourceId: proxyResource.ref,
      httpMethod: "ANY", authorizationType: "NONE",
      requestParameters: { "method.request.path.proxy": true }, integration,
    } satisfies apigateway.CfnMethodProps;
    const proxyMethod = new apigateway.CfnMethod(this, "ProxyMethod", methodProps);
    proxyMethod.overrideLogicalId("ProxyMethod");
    proxyMethod.addResourceDependency(this.listener);

    // API Gateway deployments are snapshots; changes must create a new deployment.
    const deploymentHash = createHash("sha256")
      .update(JSON.stringify(Stack.of(this).resolve(methodProps))).digest("hex").slice(0, 12);
    const deployment = new apigateway.CfnDeployment(this, "ApiDeployment", { restApiId: restApi.ref });
    deployment.overrideLogicalId("ApiDeployment" + deploymentHash);
    deployment.addResourceDependency(proxyMethod);
    const stage = new apigateway.CfnStage(this, "ApiStage", {
      restApiId: restApi.ref, deploymentId: deployment.ref, stageName: "prod",
      methodSettings: [{
        resourcePath: "/*", httpMethod: "*", throttlingBurstLimit: 100,
        throttlingRateLimit: 50, dataTraceEnabled: false,
      }],
    });
    stage.overrideLogicalId("ApiStage");
    this.apiUrl = Fn.sub("https://${RestApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/prod");
  }
}
