import assert from "node:assert/strict";
import test from "node:test";

import {
  createRemoteMailImageCapability,
  verifyRemoteMailImageCapability,
} from "./remote-mail-image-capability";

const messageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const userId = "11111111-1111-4111-8111-111111111111";
const secret = "a-test-secret-that-is-not-used-outside-this-test";

test("remote image capabilities preserve their signed ownership contract", () => {
  const capability = createRemoteMailImageCapability(
    { messageId, userId },
    { now: 1_000, secret },
  );

  assert.deepEqual(
    verifyRemoteMailImageCapability(capability, { now: 2_000, secret }),
    { messageId, userId },
  );
  assert.equal(
    verifyRemoteMailImageCapability(`${capability}changed`, {
      now: 2_000,
      secret,
    }),
    null,
  );
});

test("remote image capabilities expire", () => {
  const capability = createRemoteMailImageCapability(
    { messageId, userId },
    { now: 1_000, secret },
  );

  assert.equal(
    verifyRemoteMailImageCapability(capability, {
      now: 301_000,
      secret,
    }),
    null,
  );
});
