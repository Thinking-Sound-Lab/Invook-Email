import type { FastifyPluginAsync } from "fastify";

import { mailboxViews, type MailboxView } from "@invook/contracts";
import {
  enqueueGmailHistoryCatchupForUser,
  getMailboxSettings,
  getMailboxShellData,
  getMailboxSidebarCounts,
  getMailboxThreadDetail,
  listMailboxThreads,
  markGmailReplicaDeletingForUser,
  parseMailboxCursor,
} from "@invook/database";

import { isUuid, mutationAccessHooks, requireSession } from "../access";
import { sendJson, sendProblem } from "../responses";
import { serializeMailboxShell } from "../serializers";

type MailboxQuery = {
  cursor?: unknown;
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
  api.get(
    "/v1/mailbox/shell",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const shell = await getMailboxShellData(session.userId);
      if (!shell) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }
      await sendJson(reply, 200, serializeMailboxShell(shell, session.user));
    },
  );

  api.get(
    "/v1/mailbox/sidebar-counts",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const counts = await getMailboxSidebarCounts(session.userId);
      if (!counts) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }
      await sendJson(reply, 200, counts);
    },
  );

  api.get<{ Querystring: MailboxQuery }>(
    "/v1/mailbox/threads",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
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
      const threadPage = await listMailboxThreads(session.userId, {
        cursor,
        view,
      });
      if (!threadPage) {
        await sendProblem(
          request,
          reply,
          404,
          "Connected Gmail account not found",
        );
        return;
      }

      await sendJson(reply, 200, threadPage);
    },
  );

  api.get<{ Params: { threadId: string } }>(
    "/v1/mailbox/threads/:threadId",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (!isUuid(request.params.threadId)) {
        await sendProblem(request, reply, 400, "Invalid mailbox thread");
        return;
      }
      const thread = await getMailboxThreadDetail(
        session.userId,
        request.params.threadId,
      );
      if (!thread) {
        await sendProblem(request, reply, 404, "Mailbox thread not found");
        return;
      }
      await sendJson(reply, 200, thread);
    },
  );

  api.get(
    "/v1/mailbox/settings",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const settings = await getMailboxSettings(session.userId);
      if (!settings) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }
      await sendJson(reply, 200, settings);
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
