import type { IncomingMessage, ServerResponse } from "node:http";

import {
  getMemoryBatchWebhookSecret,
  type MemoryBatchProvider,
} from "@invook/ai";
import { enqueueMemoryBatchEvent } from "@invook/database";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

import { readRawBody } from "../http/request";
import { sendJson, sendProblem } from "../http/responses";

const supportedEvents = new Set([
  "batch.completed",
  "batch.failed",
  "batch.cancelled",
  "batch.expired",
]);

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function handleMemoryBatchWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  provider: MemoryBatchProvider,
) {
  const providerName = provider === "openai" ? "OpenAI" : "Azure OpenAI";
  const signingSecret = getMemoryBatchWebhookSecret(provider);
  if (!signingSecret) {
    sendProblem(
      response,
      requestId,
      503,
      `${providerName} webhook is not configured`,
    );
    return;
  }

  const webhookId = headerValue(request, "webhook-id");
  const webhookTimestamp = headerValue(request, "webhook-timestamp");
  const webhookSignature = headerValue(request, "webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    sendProblem(
      response,
      requestId,
      400,
      `${providerName} webhook signature is missing`,
    );
    return;
  }

  let event: unknown;
  try {
    const body = await readRawBody(request);
    event = new Webhook(signingSecret).verify(body, {
      "webhook-id": webhookId,
      "webhook-timestamp": webhookTimestamp,
      "webhook-signature": webhookSignature,
    });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      sendProblem(
        response,
        requestId,
        400,
        `${providerName} webhook signature is invalid`,
      );
      return;
    }
    throw error;
  }

  if (!event || typeof event !== "object") {
    sendProblem(
      response,
      requestId,
      400,
      `${providerName} webhook payload is invalid`,
    );
    return;
  }
  const eventType = "type" in event ? event.type : undefined;
  const data = "data" in event ? event.data : undefined;
  if (
    typeof eventType !== "string" ||
    !supportedEvents.has(eventType) ||
    !data ||
    typeof data !== "object" ||
    !("id" in data) ||
    typeof data.id !== "string" ||
    !data.id.trim()
  ) {
    sendProblem(
      response,
      requestId,
      400,
      `${providerName} webhook event is unsupported`,
    );
    return;
  }

  const queued = await enqueueMemoryBatchEvent({
    provider,
    webhookId,
    eventType,
    providerBatchId: data.id,
  });
  if (!queued) {
    sendProblem(
      response,
      requestId,
      409,
      `${providerName} batch submission is not ready`,
    );
    return;
  }
  sendJson(response, requestId, 202, { received: true });
}
