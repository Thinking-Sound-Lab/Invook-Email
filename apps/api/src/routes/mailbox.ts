import type { FastifyPluginAsync } from "fastify";

import {
  enqueueIncrementalSyncForUser,
  getMailboxWorkspace,
  waitForMailboxSyncCompletion,
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
      if (result.jobId === null) {
        await sendProblem(
          request,
          reply,
          result.reason === "not_found" ? 404 : 409,
          result.reason === "not_found"
            ? "Connected Gmail account not found"
            : "Initial Gmail indexing is not complete",
        );
        return;
      }
      const completion = await waitForMailboxSyncCompletion({
        userId: session.userId,
        jobId: result.jobId,
      });
      if (!completion) {
        await sendProblem(
          request,
          reply,
          404,
          "Gmail synchronization job not found",
        );
        return;
      }
      if (completion.status === "failed") {
        await sendProblem(request, reply, 502, "Gmail synchronization failed");
        return;
      }
      await sendJson(reply, 200, {
        completed: true,
        jobId: result.jobId,
        result: completion.result,
      });
    },
  );
};
