import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchRemoteMailImage,
  isPublicNetworkAddress,
  normalizeRemoteMailImageUrl,
  UnsafeRemoteMailImageUrlError,
} from "./remote-mail-image";

test("remote image URL normalization accepts only ordinary HTTP image origins", () => {
  assert.equal(
    normalizeRemoteMailImageUrl("https://images.example.com/banner.png#section"),
    "https://images.example.com/banner.png",
  );
  assert.equal(
    normalizeRemoteMailImageUrl("//images.example.com/banner.png"),
    "https://images.example.com/banner.png",
  );
  assert.equal(normalizeRemoteMailImageUrl("data:image/png;base64,abc"), null);
  assert.equal(
    normalizeRemoteMailImageUrl("http://example.com:8080/image.png"),
    null,
  );
  assert.equal(
    normalizeRemoteMailImageUrl("https://user@example.com/image.png"),
    null,
  );
});

test("remote image proxy rejects non-public network addresses", async () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
  assert.equal(isPublicNetworkAddress("8.8.8.8"), true);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);

  await assert.rejects(
    () => fetchRemoteMailImage("http://127.0.0.1/private.png"),
    UnsafeRemoteMailImageUrlError,
  );

  await assert.rejects(
    () =>
      fetchRemoteMailImage("https://metadata.example/image.png", {
        resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    UnsafeRemoteMailImageUrlError,
  );
});
