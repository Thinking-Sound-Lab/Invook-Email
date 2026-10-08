import { Fn, RemovalPolicy, aws_s3 as s3 } from "aws-cdk-lib";
import { Construct } from "constructs";

export class MailStorage extends Construct {
  readonly bucket: s3.CfnBucket;

  constructor(scope: Construct, constructId: string) {
    super(scope, constructId);
    this.bucket = new s3.CfnBucket(this, "MailBucket", {
      bucketName: Fn.sub("${AWS::StackName}-${AWS::AccountId}-${AWS::Region}-mail"),
      ownershipControls: { rules: [{ objectOwnership: "BucketOwnerEnforced" }] },
      publicAccessBlockConfiguration: {
        blockPublicAcls: true, blockPublicPolicy: true,
        ignorePublicAcls: true, restrictPublicBuckets: true,
      },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [{
          serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
        }],
      },
      lifecycleConfiguration: {
        rules: [{
          id: "AbortIncompleteUploads", status: "Enabled",
          abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
        }],
      },
    });
    // Stable logical IDs adopt the existing production stack without replacing stored mail.
    this.bucket.overrideLogicalId("MailBucket");
    this.bucket.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const bucketPolicy = new s3.CfnBucketPolicy(this, "MailBucketPolicy", {
      bucket: this.bucket.ref,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Deny", Principal: "*", Action: "s3:*",
          Resource: [this.bucket.attrArn, Fn.sub("${MailBucket.Arn}/*")],
          Condition: { Bool: { "aws:SecureTransport": false } },
        }],
      },
    });
    bucketPolicy.overrideLogicalId("MailBucketPolicy");
  }
}
