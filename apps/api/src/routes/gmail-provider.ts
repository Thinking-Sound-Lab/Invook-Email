import type { FastifyPluginAsync } from "fastify";

import type {
  GmailForwardedTextResponse,
  SetGmailThreadReadStateRequest,
} from "@invook/contracts";
import { buildGmailForwardedMessageText } from "@invook/contracts/gmail-forward";
import {
  enqueueGmailHistoryCatchup,
  getGmailForwardContext,
  getGmailMessageMutationContext,
  getGmailThreadMutationContext,
} from "@invook/database";
import {
  GmailApiError,
  modifyGmailMessageLabels,
  trashGmailMessage,
  type GmailSystemLabelId,
} from "@invook/gmail";

import {
  mutationAccessHooks,
  requireSession,
  requireUuidParameter,
} from "../access";
import { parseRequiredMailboxAccountId } from "../mailbox-account-scope";
import { sendJson, sendProblem } from "../responses";
import type { GmailProviderAccess } from "../services/gmail-provider";
import { setGmailThreadReadState } from "../services/gmail-thread-read-state";
import {
  getGmailProviderAccessForAccountRequest,
  sendGmailWriteProblem,
} from "./gmail-provider-access";

type GmailMessageParams = { messageId: string };
type GmailThreadParams = { threadId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const gmailMessageActions = [
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
  "archive",
  "trash",
] as const;
type GmailMessageAction = (typeof gmailMessageActions)[number];

export function gmailMessageActionMutation(action: GmailMessageAction):
  | { kind: "trash" }
  | {
      kind: "labels";
      changes: {
        addLabelIds?: GmailSystemLabelId[];
        removeLabelIds?: GmailSystemLabelId[];
      };
    } {
  switch (action) {
    case "mark_read":
      return { kind: "labels", changes: { removeLabelIds: ["UNREAD"] } };
    case "mark_unread":
      return { kind: "labels", changes: { addLabelIds: ["UNREAD"] } };
    case "star":
      return { kind: "labels", changes: { addLabelIds: ["STARRED"] } };
    case "unstar":
      return { kind: "labels", changes: { removeLabelIds: ["STARRED"] } };
    case "archive":
      return { kind: "labels", changes: { removeLabelIds: ["INBOX"] } };
    case "trash":
      return { kind: "trash" };
  }
}

function parseGmailMessageAction(body: unknown): GmailMessageAction | null {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "action") ||
    typeof body.action !== "string"
  ) {
    return null;
  }
  return gmailMessageActions.find((action) => action === body.action) ?? null;
}

export function parseGmailThreadReadState(
  body: unknown,
): SetGmailThreadReadStateRequest | null {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "isRead") ||
    typeof body.isRead !== "boolean"
  ) {
    return null;
  }
  return { isRead: body.isRead };
}

async function enqueueProviderCatchup(
  userId: string,
  access: GmailProviderAccess,
) {
  return enqueueGmailHistoryCatchup({
    userId,
    accountId: access.accountId,
    reason: "provider_write",
  });
}

export const registerGmailProviderRoutes: FastifyPluginAsync = async (api) => {
  // The text a forward appends, built by the same function the send path uses,
  // so an approval card can show the forwarded message exactly as it is sent.
  api.get<{ Params: GmailMessageParams; Querystring: { account?: unknown } }>(
    "/v1/gmail/messages/:messageId/forwarded-text",
    {
      onRequest: [
        requireSession,
        requireUuidParameter("messageId", "Message ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const accountId = parseRequiredMailboxAccountId(request.query.account);
      if (!accountId) {
        await sendProblem(request, reply, 400, "A valid mailbox account is required");
        return;
      }
      const message = await getGmailForwardContext({
        userId: session.userId,
        accountId,
        messageId: request.params.messageId,
      });
      if (!message) {
        await sendProblem(
          request,
          reply,
          404,
          "Forwarded message is unavailable for this Gmail account",
        );
        return;
      }
      const response: GmailForwardedTextResponse = {
        text: buildGmailForwardedMessageText(message),
      };
      await sendJson(reply, 200, response);
    },
  );

  api.post<{ Params: GmailMessageParams; Body: unknown }>(
    "/v1/gmail/messages/:messageId/actions",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("messageId", "Message ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const action = parseGmailMessageAction(request.body);
      if (!action) {
        await sendProblem(request, reply, 400, "Gmail message action is invalid");
        return;
      }
      const context = await getGmailMessageMutationContext({
        userId: session.userId,
        messageId: request.params.messageId,
      });
      if (!context) {
        await sendProblem(request, reply, 404, "Gmail message not found");
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        context.accountId,
      );
      if (!access) return;
      try {
        const mutation = gmailMessageActionMutation(action);
        if (mutation.kind === "trash") {
          await trashGmailMessage(
            access.accessToken,
            context.providerMessageId,
          );
        } else {
          await modifyGmailMessageLabels(
            access.accessToken,
            context.providerMessageId,
            mutation.changes,
          );
        }
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.put<{ Params: GmailThreadParams; Body: unknown }>(
    "/v1/gmail/threads/:threadId/read-state",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("threadId", "Thread ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const readState = parseGmailThreadReadState(request.body);
      if (!readState) {
        await sendProblem(request, reply, 400, "Gmail thread read state is invalid");
        return;
      }
      const context = await getGmailThreadMutationContext({
        userId: session.userId,
        threadId: request.params.threadId,
      });
      if (!context) {
        await sendProblem(request, reply, 404, "Gmail thread not found");
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        context.accountId,
      );
      if (!access) return;
      try {
        const result = await setGmailThreadReadState({
          userId: session.userId,
          access,
          context,
          isRead: readState.isRead,
        });
        if (result.status === "not_found") {
          await sendProblem(request, reply, 404, "Gmail thread not found");
          return;
        }
        await sendJson(reply, 200, { stepId: result.stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );
};
