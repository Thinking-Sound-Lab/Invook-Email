import assert from "node:assert/strict";
import { test } from "node:test";

import axios, { type AxiosRequestConfig } from "axios";

import { S3ObjectStorage } from "./index";

test("S3 requests sign temporary credentials including the session token", async (context) => {
  context.mock.method(axios, "request", async (request: AxiosRequestConfig) => {
    assert.equal(request.url, "https://s3.example.com/mail/account/message.eml");
    assert.equal(request.headers?.["X-Amz-Security-Token"], "session-token");
    assert.match(String(request.headers?.Authorization), /Credential=temporary-key\//);
    assert.match(String(request.headers?.Authorization), /SignedHeaders=.*x-amz-security-token/);
    return { data: new ArrayBuffer(0), headers: {} };
  });
  const storage = new S3ObjectStorage({
    endpoint: "https://s3.example.com", region: "us-east-1", bucket: "mail",
    credentialSource: {
      type: "static",
      credentials: { accessKeyId: "temporary-key", secretAccessKey: "secret", sessionToken: "session-token" },
    },
  });
  assert.equal((await storage.getObject("account/message.eml")).length, 0);
});
