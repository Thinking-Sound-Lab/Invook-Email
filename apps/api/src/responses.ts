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
