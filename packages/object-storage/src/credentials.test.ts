import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createObjectStorageCredentialProvider,
  getObjectStorageCredentialSource,
} from "./credentials";

test("local credentials remain static and temporary credentials retain their token", async () => {
  const source = getObjectStorageCredentialSource({
    S3_ACCESS_KEY_ID: "local-key",
    S3_SECRET_ACCESS_KEY: "local-secret",
    S3_SESSION_TOKEN: "temporary-token",
  });
  assert.deepEqual(await createObjectStorageCredentialProvider(source)(), {
    accessKeyId: "local-key",
    secretAccessKey: "local-secret",
    sessionToken: "temporary-token",
  });
  assert.throws(() => getObjectStorageCredentialSource({ S3_ACCESS_KEY_ID: "partial" }));
});

test("ECS credentials are shared across concurrent requests and refreshed before expiry", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let calls = 0;
  const provider = createObjectStorageCredentialProvider(
    getObjectStorageCredentialSource({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-id",
    }),
    {
      now: () => now,
      load: async (url) => {
        assert.equal(url, "http://169.254.170.2/v2/credentials/task-id");
        calls += 1;
        return {
          AccessKeyId: `key-${calls}`,
          SecretAccessKey: "secret",
          Token: `token-${calls}`,
          Expiration: new Date(now + 120_000).toISOString(),
        };
      },
    },
  );
  const [first, concurrent] = await Promise.all([provider(), provider()]);
  assert.deepEqual(first, concurrent);
  assert.equal(calls, 1);
  now += 59_000;
  assert.equal((await provider()).accessKeyId, "key-1");
  now += 2_000;
  assert.equal((await provider()).sessionToken, "token-2");
  assert.equal(calls, 2);
});

test("invalid ECS endpoints and incomplete credentials fail closed", async () => {
  for (const uri of ["https://example.com", "//example.com/key", "/v2/credentials/../key", "/v2/credentials/key?url=other"]) {
    assert.throws(() => getObjectStorageCredentialSource({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: uri,
    }));
  }
  const source = getObjectStorageCredentialSource({
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-id",
  });
  for (const payload of [null, {}, {
    AccessKeyId: "key", SecretAccessKey: "secret", Token: "token",
    Expiration: "2025-01-01T00:00:00Z",
  }]) {
    const provider = createObjectStorageCredentialProvider(source, {
      now: () => Date.parse("2026-01-01T00:00:00Z"),
      load: async () => payload,
    });
    await assert.rejects(provider());
  }
});

test("a failed credentials refresh can be retried on the next request", async () => {
  let calls = 0;
  const provider = createObjectStorageCredentialProvider({
    type: "ecs", relativeUri: "/v2/credentials/task-id",
  }, {
    now: () => 0,
    load: async () => {
      if (++calls === 1) throw new Error("unavailable");
      return { AccessKeyId: "key", SecretAccessKey: "secret", Token: "token", Expiration: "2026-01-01T00:00:00Z" };
    },
  });
  await assert.rejects(provider());
  assert.equal((await provider()).sessionToken, "token");
});
