import { createHash } from "node:crypto";

import { withRemoteMailImageCacheLock } from "@invook/database";
import {
  createObjectStorage,
  ObjectStorageObjectNotFoundError,
  type StoredObjectContent,
} from "@invook/object-storage";

import {
  fetchRemoteMailImage,
  isSupportedRemoteMailImageContentType,
  RemoteMailImageUnavailableError,
  type RemoteMailImage,
  UnsafeRemoteMailImageUrlError,
} from "./remote-mail-image";

const REMOTE_MAIL_IMAGE_CACHE_VERSION = "v1";

export class RemoteMailImageCacheUnavailableError extends Error {}

interface RemoteMailImageCacheDependencies {
  fetchImage?: (source: string) => Promise<RemoteMailImage>;
  readObject?: (key: string) => Promise<StoredObjectContent>;
  writeObject?: (input: {
    key: string;
    image: RemoteMailImage;
  }) => Promise<void>;
  withCacheLock?: <T>(
    cacheKey: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

function remoteMailImageCacheKey(source: string): string {
  const sourceHash = createHash("sha256").update(source).digest("hex");
  return `remote-mail-images/${REMOTE_MAIL_IMAGE_CACHE_VERSION}/${sourceHash}`;
}

function normalizeCachedImage(content: StoredObjectContent): RemoteMailImage {
  if (
    content.body.byteLength === 0 ||
    !content.contentType ||
    !isSupportedRemoteMailImageContentType(content.contentType)
  ) {
    throw new RemoteMailImageCacheUnavailableError();
  }
  return { bytes: content.body, contentType: content.contentType };
}

export async function getRemoteMailImage(
  source: string,
  dependencies: RemoteMailImageCacheDependencies = {},
): Promise<RemoteMailImage> {
  let objectStorage: ReturnType<typeof createObjectStorage> | null = null;
  if (!dependencies.readObject || !dependencies.writeObject) {
    try {
      objectStorage = createObjectStorage();
    } catch {
      throw new RemoteMailImageCacheUnavailableError();
    }
  }
  const readObject =
    dependencies.readObject ??
    ((key: string) => {
      if (!objectStorage) throw new RemoteMailImageCacheUnavailableError();
      return objectStorage.getObjectContent(key);
    });
  const writeObject =
    dependencies.writeObject ??
    (async ({ key, image }: { key: string; image: RemoteMailImage }) => {
      if (!objectStorage) throw new RemoteMailImageCacheUnavailableError();
      await objectStorage.putObject({
        key,
        body: image.bytes,
        contentType: image.contentType,
      });
    });
  const fetchImage = dependencies.fetchImage ?? fetchRemoteMailImage;
  const withCacheLock =
    dependencies.withCacheLock ?? withRemoteMailImageCacheLock;
  const cacheKey = remoteMailImageCacheKey(source);

  const readCachedImage = async (): Promise<RemoteMailImage | null> => {
    try {
      return normalizeCachedImage(await readObject(cacheKey));
    } catch (error) {
      if (error instanceof ObjectStorageObjectNotFoundError) return null;
      if (error instanceof RemoteMailImageCacheUnavailableError) throw error;
      throw new RemoteMailImageCacheUnavailableError();
    }
  };

  const cachedImage = await readCachedImage();
  if (cachedImage) return cachedImage;

  try {
    return await withCacheLock(cacheKey, async () => {
      const imageCachedByAnotherRequest = await readCachedImage();
      if (imageCachedByAnotherRequest) return imageCachedByAnotherRequest;

      const fetchedImage = await fetchImage(source);
      try {
        await writeObject({ key: cacheKey, image: fetchedImage });
      } catch {
        throw new RemoteMailImageCacheUnavailableError();
      }
      return fetchedImage;
    });
  } catch (error) {
    if (
      error instanceof RemoteMailImageCacheUnavailableError ||
      error instanceof RemoteMailImageUnavailableError ||
      error instanceof UnsafeRemoteMailImageUrlError
    ) {
      throw error;
    }
    throw new RemoteMailImageCacheUnavailableError();
  }
}
