import type { FastifyPluginAsync } from "fastify";

import { mailboxViews, type MailboxView } from "@invook/contracts";
import {
  enqueueGmailHistoryCatchupForUser,
  getMailboxWorkspace,
  markGmailReplicaDeletingForUser,
  parseMailboxCursor,
} from "@invook/database";

import { isUuid, mutationAccessHooks, requireSession } from "../access";
import { sendJson, sendProblem } from "../responses";
import { serializeWorkspace } from "../serializers";

type MailboxQuery = {
  cursor?: unknown;
  thread?: unknown;
  view?: unknown;
};

const mailboxViewSet = new Set<string>(mailboxViews);

function parseMailboxView(value: unknown): MailboxView | null {
  if (value === undefined || value === "") return "all";
  if (typeof value !== "string") return null;
  if (mailboxViewSet.has(value)) return value as MailboxView;
  const labelId = value.startsWith("label:") ? value.slice(6) : "";
  return isUuid(labelId) ? (`label:${labelId}` as const) : null;
}

export const registerMailboxRoutes: FastifyPluginAsync = async (api) => {
  api.get<{ Querystring: MailboxQuery }>(
    "/v1/mailbox",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;

      const threadId =
        typeof request.query.thread === "string"
          ? request.query.thread.trim() || undefined
          : undefined;
      const view = parseMailboxView(request.query.view);
      if (!view) {
        await sendProblem(request, reply, 400, "Invalid mailbox view");
        return;
      }
      const requestedCursor =
        typeof request.query.cursor === "string" ? request.query.cursor.trim() : "";
      const cursor = requestedCursor ? parseMailboxCursor(requestedCursor) : null;
      if (requestedCursor && !cursor) {
        await sendProblem(request, reply, 400, "Invalid mailbox cursor");
        return;
      }
      const workspace = await getMailboxWorkspace(session.userId, {
        cursor,
        selectedThreadId: threadId,
        view,
      });
      if (!workspace) {
        await sendProblem(
          request,
          reply,
          404,
          "Connected Gmail account not found",
        );
        return;
      }

      await sendJson(reply, 200, await serializeWorkspace(workspace));
    },
  );

  api.post(
    "/v1/mailbox/sync",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const result = await enqueueGmailHistoryCatchupForUser(session.userId);
      if (result.stepId === null) {
        await sendProblem(
          request,
          reply,
          result.reason === "not_found" ? 404 : 409,
          result.reason === "not_found"
            ? "Connected Gmail account not found"
            : "Gmail mailbox replica is not ready",
        );
        return;
      }
      await sendJson(reply, 202, {
        accepted: true,
        stepId: result.stepId,
      });
    },
  );

  api.delete(
    "/v1/mailbox/account",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const result = await markGmailReplicaDeletingForUser(session.userId);
      if (!result.cleanupId) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }
      await sendJson(reply, 202, {
        accepted: true,
        cleanupId: result.cleanupId,
      });
    },
  );
};
