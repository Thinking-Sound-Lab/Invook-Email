import type { IncomingMessage } from "node:http";

import { getPublicAppOrigin } from "../config";

export function getRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

export async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = 65_536,
): Promise<unknown> {
  const body = await readRawBody(request, maximumBytes);
  if (body.byteLength === 0) return null;
  return JSON.parse(body.toString("utf8")) as unknown;
}

export async function readRawBody(
  request: IncomingMessage,
  maximumBytes = 65_536,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function hasAllowedMutationOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || origin === getPublicAppOrigin();
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
