import type { IncomingMessage, ServerResponse } from "node:http";

import { enqueueGeminiBatchEvent } from "@invook/database";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

import { readRawBody } from "../http/request";
import { sendJson, sendProblem } from "../http/responses";

const supportedEvents = new Set([
  "batch.succeeded",
  "batch.failed",
  "batch.cancelled",
  "batch.expired",
]);

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function handleGeminiWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  const signingSecret = process.env.GEMINI_WEBHOOK_SECRET?.trim();
  if (!signingSecret) {
    sendProblem(response, requestId, 503, "Gemini webhook is not configured");
    return;
  }

  const webhookId = headerValue(request, "webhook-id");
  const webhookTimestamp = headerValue(request, "webhook-timestamp");
  const webhookSignature = headerValue(request, "webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    sendProblem(response, requestId, 400, "Gemini webhook signature is missing");
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
      sendProblem(response, requestId, 400, "Gemini webhook signature is invalid");
      return;
    }
    throw error;
  }

  if (!event || typeof event !== "object") {
    sendProblem(response, requestId, 400, "Gemini webhook payload is invalid");
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
    sendProblem(response, requestId, 400, "Gemini webhook event is unsupported");
    return;
  }

  await enqueueGeminiBatchEvent({
    webhookId,
    eventType,
    providerBatchId: data.id,
    outputFileUri:
      "output_file_uri" in data ? optionalString(data.output_file_uri) : undefined,
    errorCode: "error_code" in data ? optionalString(data.error_code) : undefined,
    errorMessage:
      "error_message" in data ? optionalString(data.error_message) : undefined,
  });
  sendJson(response, requestId, 202, { received: true });
}
