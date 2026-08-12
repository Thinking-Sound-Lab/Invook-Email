import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { FastifyInstance } from "fastify";
import { validate as validateUuid } from "uuid";

import { buildApi } from "./app";

let api: FastifyInstance;
const originalAppUrl = process.env.APP_URL;
const originalOpenAiWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET;

before(async () => {
  process.env.APP_URL = "http://localhost:3000";
  delete process.env.OPENAI_WEBHOOK_SECRET;
  api = await buildApi();
});

after(async () => {
  await api.close();
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }
  if (originalOpenAiWebhookSecret === undefined) {
    delete process.env.OPENAI_WEBHOOK_SECRET;
  } else {
    process.env.OPENAI_WEBHOOK_SECRET = originalOpenAiWebhookSecret;
  }
});

test("liveness uses the existing response contract", async () => {
  const response = await api.inject({ method: "GET", url: "/health/live" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(validateUuid(response.headers["x-request-id"] ?? ""), true);
});

test("the reverse proxy request ID and trailing slash are preserved", async () => {
  const response = await api.inject({
    method: "GET",
    url: "/health/live/",
    headers: { "x-request-id": "request-from-proxy" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-request-id"], "request-from-proxy");
});

test("an anonymous session remains an honest disconnected state", async () => {
  const response = await api.inject({ method: "GET", url: "/v1/session" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authenticated: false,
    gmailConnected: false,
  });
});

test("authentication runs before JSON body parsing", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/labels",
    headers: { "content-type": "application/json" },
    payload: "{",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("mailbox refresh requires an authenticated session", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/mailbox/sync",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("unknown routes use the API problem contract", async () => {
  const response = await api.inject({ method: "GET", url: "/not-a-route" });
  const problem = response.json();

  assert.equal(response.statusCode, 404);
  assert.equal(response.headers["content-type"], "application/problem+json; charset=utf-8");
  assert.equal(problem.type, "about:blank");
  assert.equal(problem.title, "Route not found");
  assert.equal(problem.status, 404);
  assert.equal(problem.requestId, response.headers["x-request-id"]);
});

test("webhooks use their raw-body route before JSON parsing", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/webhooks/openai",
    headers: { "content-type": "application/json" },
    payload: Buffer.from("not-json"),
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().title, "OpenAI webhook is not configured");
});
