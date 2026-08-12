import type { FastifyPluginAsync } from "fastify";

import { setUserThreadLabel } from "@invook/database";

import {
  isUuid,
  mutationAccessHooks,
  requireUuidParameter,
} from "../access";
import { sendJson, sendProblem } from "../responses";

type ThreadLabelParams = {
  threadId: string;
};

export const registerThreadLabelRoutes: FastifyPluginAsync = async (api) => {
  api.patch<{ Params: ThreadLabelParams; Body: unknown }>(
    "/:threadId/labels",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("threadId", "Thread ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const body = request.body;
      if (!body || typeof body !== "object") {
        await sendProblem(request, reply, 400, "A label decision is required");
        return;
      }

      const labelId = "labelId" in body ? body.labelId : undefined;
      const applied = "applied" in body ? body.applied : undefined;
      if (
        typeof labelId !== "string" ||
        !isUuid(labelId) ||
        typeof applied !== "boolean"
      ) {
        await sendProblem(
          request,
          reply,
          400,
          "Label ID and applied must be valid",
        );
        return;
      }

      const labels = await setUserThreadLabel({
        userId: session.userId,
        threadId: request.params.threadId,
        labelId,
        applied,
      });
      if (!labels) {
        await sendProblem(request, reply, 404, "Email thread not found");
        return;
      }
      await sendJson(reply, 200, { labels });
    },
  );
};
