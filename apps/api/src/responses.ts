import { Readable } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { ApiProblem } from "@invook/contracts";

export class InvalidJsonBodyError extends Error {
  readonly statusCode = 400;

  constructor() {
    super("Invalid JSON request body");
    this.name = "InvalidJsonBodyError";
  }
}

export function sendJson(reply: FastifyReply, status: number, body: unknown) {
  return reply.code(status).type("application/json; charset=utf-8").send(body);
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
) {
  const problem: ApiProblem = {
    type: "about:blank",
    title,
    status,
    requestId: request.id,
  };
  return reply
    .code(status)
    .type("application/problem+json; charset=utf-8")
    .send(problem);
}

export function sendRedirect(
  reply: FastifyReply,
  location: string,
  status: 302 | 303,
) {
  return reply.code(status).header("location", location).send();
}

/**
 * Sends a web-standard Response produced by an embedded handler, such as
 * Better Auth or the MCP SDK. Event streams are piped as they are produced;
 * every other body is buffered.
 */
export async function sendWebResponse(
  response: Response,
  reply: FastifyReply,
): Promise<void> {
  const setCookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie" && name !== "content-length") {
      reply.header(name, value);
    }
  });
  if (setCookies.length > 0) reply.header("set-cookie", setCookies);

  reply.status(response.status);
  if (!response.body) {
    await reply.send();
    return;
  }
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    await reply.send(Readable.fromWeb(response.body));
    return;
  }
  await reply.send(Buffer.from(await response.arrayBuffer()));
}
