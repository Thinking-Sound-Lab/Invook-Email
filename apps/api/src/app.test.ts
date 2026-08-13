import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { FastifyInstance } from "fastify";
import { validate as validateUuid } from "uuid";

import { buildApi } from "./app";
import { parseGmailNotification } from "./routes/google-pubsub";
import { composePlainTextGmailReply } from "./services/gmail-drafts";

let api: FastifyInstance;
const originalAppUrl = process.env.APP_URL;
const originalOpenAiWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
const originalGooglePubSubAudience = process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
const originalGooglePubSubServiceAccountEmail =
  process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
const originalGooglePubSubSubscription = process.env.GOOGLE_PUBSUB_SUBSCRIPTION;

before(async () => {
  process.env.APP_URL = "http://localhost:3000";
  delete process.env.OPENAI_WEBHOOK_SECRET;
  delete process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
  delete process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
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
  if (originalGooglePubSubAudience === undefined) {
    delete process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
  } else {
    process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE = originalGooglePubSubAudience;
  }
  if (originalGooglePubSubServiceAccountEmail === undefined) {
    delete process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
  } else {
    process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL =
      originalGooglePubSubServiceAccountEmail;
  }
  if (originalGooglePubSubSubscription === undefined) {
    delete process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  } else {
    process.env.GOOGLE_PUBSUB_SUBSCRIPTION = originalGooglePubSubSubscription;
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

test("signing out clears only the browser session cookie", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/auth/sign-out",
  });

  const setCookie = response.headers["set-cookie"];
  const sessionCookie = Array.isArray(setCookie)
    ? setCookie.join("; ")
    : setCookie ?? "";
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, "http://localhost:3000/");
  assert.match(sessionCookie, /^invook_session=;/);
  assert.match(sessionCookie, /Max-Age=0/);
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

test("mailbox audit and deletion require an authenticated session", async () => {
  for (const request of [
    { method: "POST", url: "/v1/mailbox/audit" },
    { method: "DELETE", url: "/v1/mailbox/account" },
  ] as const) {
    const response = await api.inject(request);
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().title, "Authentication required");
  }
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

test("Google Pub/Sub push reports missing authentication configuration", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/webhooks/google-pubsub",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.json().title,
    "Google Pub/Sub push authentication is not configured",
  );
});

test("Google Pub/Sub authenticates before parsing its push body", async () => {
  process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE = "http://localhost:3000/v1/webhooks/google-pubsub";
  process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL = "gmail-push@example.com";
  process.env.GOOGLE_PUBSUB_SUBSCRIPTION =
    "projects/invook/subscriptions/gmail-mailbox-changes";
  try {
    const response = await api.inject({
      method: "POST",
      url: "/v1/webhooks/google-pubsub",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().title, "Google Pub/Sub authentication required");
  } finally {
    delete process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
    delete process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  }
});

test("Google Pub/Sub preserves numeric Gmail history IDs exactly", () => {
  const data = Buffer.from(
    '{"emailAddress":"mailbox@example.com","historyId":18446744073709551615}',
    "utf8",
  ).toString("base64");

  assert.deepEqual(parseGmailNotification(data), {
    emailAddress: "mailbox@example.com",
    historyId: "18446744073709551615",
  });
});

test("mailbox change events require an authenticated session", async () => {
  const response = await api.inject({ method: "GET", url: "/v1/mailbox/events" });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("Gmail provider writes require an authenticated session", async () => {
  const requests = [
    { method: "POST", url: "/v1/gmail/labels" },
    { method: "PATCH", url: "/v1/gmail/labels/not-a-uuid" },
    { method: "DELETE", url: "/v1/gmail/labels/not-a-uuid" },
    { method: "PATCH", url: "/v1/gmail/messages/not-a-uuid/labels" },
    { method: "PUT", url: "/v1/gmail/drafts/not-a-uuid" },
    { method: "DELETE", url: "/v1/gmail/drafts/not-a-uuid" },
    { method: "POST", url: "/v1/drafts/not-a-uuid/save-to-gmail" },
  ] as const;

  for (const request of requests) {
    const response = await api.inject(request);
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    assert.equal(response.json().title, "Authentication required");
  }
});

test("plain-text Gmail replies preserve threading headers and prevent header injection", () => {
  const raw = composePlainTextGmailReply({
    accountEmail: "sender@example.com",
    subject: "Quarterly update\r\nBcc: hidden@example.com",
    currentText: "First line\nSecond line",
    replyTarget: {
      sender: { raw: "Recipient <recipient@example.com>", email: "recipient@example.com" },
      headerLines: [
        {
          key: "reply-to",
          line: "Reply-To: replies@example.com\r\nBcc: hidden@example.com",
        },
        { key: "message-id", line: "Message-ID: <message@example.com>" },
        { key: "references", line: "References: <parent@example.com>" },
      ],
    },
  });

  assert.ok(raw);
  const message = raw.toString("utf8");
  assert.match(message, /^From: sender@example\.com\r\nTo: replies@example\.com Bcc: hidden@example\.com\r\n/);
  assert.match(message, /\r\nIn-Reply-To: <message@example\.com>\r\n/);
  assert.match(
    message,
    /\r\nReferences: <parent@example\.com> <message@example\.com>\r\n/,
  );
  assert.match(message, /\r\n\r\nFirst line\r\nSecond line$/);
  assert.doesNotMatch(message, /\r\nBcc:/);
});
