import { createHash } from "node:crypto";

import aws4 from "aws4";
import axios, { type AxiosRequestConfig } from "axios";

export type ObjectStorageConfiguration = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type StoredObject = {
  key: string;
  checksumSha256: string;
  contentLength: number;
  etag: string | null;
};

export class ObjectStorageObjectNotFoundError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super("The stored object was not found.", options);
    this.name = "ObjectStorageObjectNotFoundError";
  }
}

function requireValue(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for object storage.`);
  return normalized;
}

export function getObjectStorageConfiguration(): ObjectStorageConfiguration {
  return {
    endpoint: requireValue("S3_ENDPOINT", process.env.S3_ENDPOINT).replace(/\/$/, ""),
    region: requireValue("S3_REGION", process.env.S3_REGION),
    bucket: requireValue("S3_BUCKET", process.env.S3_BUCKET),
    accessKeyId: requireValue("S3_ACCESS_KEY_ID", process.env.S3_ACCESS_KEY_ID),
    secretAccessKey: requireValue(
      "S3_SECRET_ACCESS_KEY",
      process.env.S3_SECRET_ACCESS_KEY,
    ),
  };
}

function encodedKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export class S3ObjectStorage {
  constructor(private readonly configuration: ObjectStorageConfiguration) {}

  private async request<T>(input: {
    method: "GET" | "PUT" | "DELETE";
    key: string;
    body?: Buffer;
    contentType?: string;
    checksumSha256?: string;
    responseType?: "arraybuffer";
  }) {
    const url = new URL(
      `${this.configuration.endpoint}/${encodeURIComponent(this.configuration.bucket)}/${encodedKey(input.key)}`,
    );
    const headers: Record<string, string> = {
      host: url.host,
    };
    if (input.body) {
      headers["content-length"] = String(input.body.byteLength);
      headers["content-type"] = input.contentType ?? "application/octet-stream";
      headers["x-amz-content-sha256"] =
        input.checksumSha256 ?? createHash("sha256").update(input.body).digest("hex");
      headers["x-amz-meta-sha256"] = headers["x-amz-content-sha256"];
    }

    const signed = aws4.sign(
      {
        host: url.host,
        path: url.pathname,
        service: "s3",
        region: this.configuration.region,
        method: input.method,
        headers,
        body: input.body,
      },
      {
        accessKeyId: this.configuration.accessKeyId,
        secretAccessKey: this.configuration.secretAccessKey,
      },
    );
    const signedHeaders = Object.fromEntries(
      Object.entries(signed.headers ?? {}).flatMap(([name, value]) => {
        if (value === undefined) return [];
        return [[name, Array.isArray(value) ? value.join(", ") : String(value)]];
      }),
    );
    const request: AxiosRequestConfig = {
      method: input.method,
      url: url.toString(),
      headers: signedHeaders,
      data: input.body,
      responseType: input.responseType,
      maxBodyLength: Number.POSITIVE_INFINITY,
      maxContentLength: Number.POSITIVE_INFINITY,
      validateStatus: (status) => status >= 200 && status < 300,
    };
    return axios.request<T>(request);
  }

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<StoredObject> {
    const checksumSha256 = createHash("sha256").update(input.body).digest("hex");
    const response = await this.request<void>({
      method: "PUT",
      key: input.key,
      body: input.body,
      contentType: input.contentType,
      checksumSha256,
    });
    const rawEtag = response.headers.etag;
    return {
      key: input.key,
      checksumSha256,
      contentLength: input.body.byteLength,
      etag: typeof rawEtag === "string" ? rawEtag.replace(/^"|"$/g, "") : null,
    };
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      const response = await this.request<ArrayBuffer>({
        method: "GET",
        key,
        responseType: "arraybuffer",
      });
      return Buffer.from(response.data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new ObjectStorageObjectNotFoundError({ cause: error });
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.request<void>({ method: "DELETE", key });
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += 20) {
      await Promise.all(
        keys.slice(index, index + 20).map((key) => this.deleteObject(key)),
      );
    }
  }
}

export function createObjectStorage(
  configuration = getObjectStorageConfiguration(),
): S3ObjectStorage {
  return new S3ObjectStorage(configuration);
}
