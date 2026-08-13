import "server-only";

import axios from "axios";
import { Readable } from "node:stream";

function getApiOrigin(): string {
  return (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

export async function proxyEventStream(request: Request, path: string) {
  const headers: Record<string, string> = {
    accept: "text/event-stream",
  };
  const cookie = request.headers.get("cookie");
  const lastEventId = request.headers.get("last-event-id");
  if (cookie) headers.cookie = cookie;
  if (lastEventId) headers["last-event-id"] = lastEventId;

  const upstream = await axios.get(`${getApiOrigin()}${path}`, {
    headers,
    responseType: "stream",
    signal: request.signal,
    validateStatus: () => true,
  });
  const responseHeaders = new Headers();
  for (const name of [
    "cache-control",
    "content-type",
    "x-accel-buffering",
    "x-content-type-options",
    "x-request-id",
  ]) {
    const value = upstream.headers[name];
    if (typeof value === "string") responseHeaders.set(name, value);
  }

  const body = Readable.toWeb(upstream.data as Readable) as unknown as ReadableStream;
  return new Response(body, {
    headers: responseHeaders,
    status: upstream.status,
  });
}
