import type { ServerResponse } from "node:http";

import type { ApiProblem } from "@invook/contracts";

function setCommonHeaders(response: ServerResponse, requestId: string) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-request-id", requestId);
}

export function sendJson(
  response: ServerResponse,
  requestId: string,
  status: number,
  body: unknown,
) {
  setCommonHeaders(response, requestId);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function sendProblem(
  response: ServerResponse,
  requestId: string,
  status: number,
  title: string,
) {
  const problem: ApiProblem = {
    type: "about:blank",
    title,
    status,
    requestId,
  };
  setCommonHeaders(response, requestId);
  response.statusCode = status;
  response.setHeader("content-type", "application/problem+json; charset=utf-8");
  response.end(JSON.stringify(problem));
}

export function sendRedirect(
  response: ServerResponse,
  requestId: string,
  location: string,
  status: 302 | 303,
  cookies: string[] = [],
) {
  setCommonHeaders(response, requestId);
  response.statusCode = status;
  response.setHeader("location", location);
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  response.end();
}
