import type { FastifyPluginAsync } from "fastify";

import { AiConfigurationError } from "@invook/ai";
import { saveDraftEdit } from "@invook/database";

import { mutationAccessHooks, requireUuidParameter } from "../access";
import { sendJson, sendProblem } from "../responses";
import { serializeReplyDraft } from "../serializers";
import { generateDraftForUser } from "../services/drafts";

type ThreadParams = {
  threadId: string;
};

type DraftParams = {
  draftId: string;
};

export const registerDraftRoutes: FastifyPluginAsync = async (api) => {
  api.post<{ Params: ThreadParams; Body: unknown }>(
    "/v1/threads/:threadId/drafts",
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
      const instruction =
        body && typeof body === "object" && "instruction" in body
          ? body.instruction
          : undefined;
      if (
        instruction !== undefined &&
        (typeof instruction !== "string" || instruction.trim().length > 1_000)
      ) {
        await sendProblem(request, reply, 400, "Draft instruction must be valid");
        return;
      }

      try {
        const draft = await generateDraftForUser({
          userId: session.userId,
          threadId: request.params.threadId,
          instruction:
            typeof instruction === "string" && instruction.trim()
              ? instruction.trim()
              : undefined,
        });
        if (!draft) {
          await sendProblem(request, reply, 404, "Email thread not found");
          return;
        }
        await sendJson(reply, 201, { draft: serializeReplyDraft(draft) });
      } catch (error) {
        if (error instanceof AiConfigurationError) {
          await sendProblem(request, reply, 503, "AI model is not configured");
          return;
        }
        throw error;
      }
    },
  );

  api.patch<{ Params: DraftParams; Body: unknown }>(
    "/v1/drafts/:draftId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("draftId", "Draft ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const body = request.body;
      const currentText =
        body && typeof body === "object" && "currentText" in body
          ? body.currentText
          : undefined;
      if (
        typeof currentText !== "string" ||
        currentText.trim().length === 0 ||
        currentText.length > 12_000
      ) {
        await sendProblem(request, reply, 400, "Draft text must be valid");
        return;
      }

      const draft = await saveDraftEdit({
        userId: session.userId,
        draftId: request.params.draftId,
        currentText,
      });
      if (!draft) {
        await sendProblem(request, reply, 404, "Draft not found");
        return;
      }
      await sendJson(reply, 200, { draft: serializeReplyDraft(draft) });
    },
  );
};
