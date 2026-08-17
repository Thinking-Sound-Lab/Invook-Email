import assert from "node:assert/strict";
import test from "node:test";

import { ObjectStorageObjectNotFoundError } from "@invook/object-storage";

import {
  cacheRemoteMailImage,
  getCachedRemoteMailImage,
  prefetchRemoteMailImages,
  RemoteMailImageCacheUnavailableError,
} from "./remote-mail-image-cache";
import type { RemoteMailImage } from "./remote-mail-image";

test("remote image cache fetches each sender resource only once", async () => {
  const storedImages = new Map<string, RemoteMailImage>();
  const image = {
    bytes: Buffer.from([137, 80, 78, 71]),
    contentType: "image/png",
  };
  let fetchCount = 0;
  let lockTail = Promise.resolve();

  const cacheImage = () =>
    cacheRemoteMailImage("https://images.example.com/unique.png", {
      fetchImage: async () => {
        fetchCount += 1;
        return image;
      },
      readObject: async (key) => {
        const storedImage = storedImages.get(key);
        if (!storedImage) throw new ObjectStorageObjectNotFoundError();
        return {
          body: storedImage.bytes,
          contentType: storedImage.contentType,
        };
      },
      withCacheLock: async (_cacheKey, operation) => {
        const precedingLock = lockTail;
        let releaseLock: () => void = () => undefined;
        lockTail = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        await precedingLock;
        try {
          return await operation();
        } finally {
          releaseLock();
        }
      },
      writeObject: async ({ key, image: storedImage }) => {
        storedImages.set(key, storedImage);
      },
    });

  const [first, second] = await Promise.all([cacheImage(), cacheImage()]);
  const third = await cacheImage();

  assert.deepEqual(first, image);
  assert.deepEqual(second, image);
  assert.deepEqual(third, image);
  assert.equal(fetchCount, 1);
  assert.equal(storedImages.size, 1);
});

test("cache-only reads never contact the sender on a miss", async () => {
  let readCount = 0;
  const image = await getCachedRemoteMailImage(
    "https://images.example.com/unique.png",
    {
      readObject: async () => {
        readCount += 1;
        throw new ObjectStorageObjectNotFoundError();
      },
    },
  );

  assert.equal(image, null);
  assert.equal(readCount, 1);
});

test("mail ingestion prefetches every discovered remote image", async () => {
  const cachedSources: string[] = [];
  const result = await prefetchRemoteMailImages(
    '<style>.hero{background:url("https://images.example.com/background.png")}</style><img src="https://images.example.com/banner.png">',
    {
      cacheImage: async (source) => {
        cachedSources.push(source);
        return { bytes: Buffer.from([1]), contentType: "image/png" };
      },
    },
  );

  assert.deepEqual(cachedSources.sort(), [
    "https://images.example.com/background.png",
    "https://images.example.com/banner.png",
  ]);
  assert.deepEqual(result, { cachedCount: 2, unavailableCount: 0 });
});

test("remote image cache fails closed when durable storage is unavailable", async () => {
  let fetchCount = 0;

  await assert.rejects(
    () =>
      cacheRemoteMailImage("https://images.example.com/unique.png", {
        fetchImage: async () => {
          fetchCount += 1;
          return {
            bytes: Buffer.from([137, 80, 78, 71]),
            contentType: "image/png",
          };
        },
        readObject: async () => {
          throw new Error("storage offline");
        },
        withCacheLock: async (_cacheKey, operation) => operation(),
        writeObject: async () => undefined,
      }),
    RemoteMailImageCacheUnavailableError,
  );

  assert.equal(fetchCount, 0);
});

test("remote image cache fails closed when its cross-process lock is unavailable", async () => {
  let fetchCount = 0;

  await assert.rejects(
    () =>
      cacheRemoteMailImage("https://images.example.com/unique.png", {
        fetchImage: async () => {
          fetchCount += 1;
          return {
            bytes: Buffer.from([137, 80, 78, 71]),
            contentType: "image/png",
          };
        },
        readObject: async () => {
          throw new ObjectStorageObjectNotFoundError();
        },
        withCacheLock: async () => {
          throw new Error("database offline");
        },
        writeObject: async () => undefined,
      }),
    RemoteMailImageCacheUnavailableError,
  );

  assert.equal(fetchCount, 0);
});
