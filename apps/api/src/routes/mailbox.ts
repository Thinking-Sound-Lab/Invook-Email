import type { FastifyPluginAsync } from "fastify";

import {
  enqueueIncrementalSyncForUser,
  getMailboxWorkspace,
} from "@invook/database";

import { mutationAccessHooks, requireSession } from "../access";
import { sendJson, sendProblem } from "../responses";
import { serializeWorkspace } from "../serializers";

type MailboxQuery = {
  thread?: unknown;
};

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
      const workspace = await getMailboxWorkspace(session.userId, threadId);
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
      const result = await enqueueIncrementalSyncForUser(session.userId);
      if (result.reason === "not_found") {
        await sendProblem(
          request,
          reply,
          404,
          "Connected Gmail account not found",
        );
        return;
      }
      if (result.reason === "initial_sync_incomplete") {
        await sendProblem(
          request,
          reply,
          409,
          "Initial Gmail indexing is not complete",
        );
        return;
      }
      await sendJson(reply, 202, { queued: true, jobId: result.jobId });
    },
  );
};
