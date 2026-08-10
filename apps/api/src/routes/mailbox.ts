import type { FastifyPluginAsync } from "fastify";

import { getMailboxWorkspace } from "@invook/database";

import { requireSession } from "../access";
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
};
