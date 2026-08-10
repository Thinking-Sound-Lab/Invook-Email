import type { FastifyPluginAsync } from "fastify";

import { AiConfigurationError, generateReplyDraft } from "@invook/ai";
import {
  getReplyDraftContext,
  saveDraftEdit,
  saveGeneratedDraft,
} from "@invook/database";
import { extractEmailAddress } from "@invook/gmail";

import { mutationAccessHooks, requireUuidParameter } from "../access";
import { sendJson, sendProblem } from "../responses";
import { serializeReplyDraft } from "../serializers";

type ThreadParams = {
  threadId: string;
};

type DraftParams = {
  draftId: string;
};

function contactEmails(values: string[], accountEmail: string): Set<string> {
  return new Set(
    values
      .map(extractEmailAddress)
      .filter((email) => email.includes("@") && email !== accountEmail.toLowerCase()),
  );
}

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

      const context = await getReplyDraftContext(
        session.userId,
        request.params.threadId,
      );
      if (!context) {
        await sendProblem(request, reply, 404, "Email thread not found");
        return;
      }

      const contacts = contactEmails(
        [
          ...context.participants,
          ...context.messages.flatMap((message) => [
            message.sender.raw,
            ...message.recipients,
          ]),
        ],
        context.accountEmail,
      );
      const applicableMemories = context.memories.filter(
        (memory) =>
          memory.type !== "contact" ||
          Boolean(
            memory.contactEmail && contacts.has(memory.contactEmail.toLowerCase()),
          ),
      );

      try {
        const result = await generateReplyDraft({
          subject: context.subject,
          messages: context.messages.map((message) => ({
            direction: message.direction,
            sender: message.sender.raw || message.sender.email,
            recipients: message.recipients,
            bodyText: message.bodyText,
            sentAt: message.sentAt.toISOString(),
          })),
          memories: applicableMemories,
          instruction:
            typeof instruction === "string" && instruction.trim()
              ? instruction.trim()
              : undefined,
        });
        const applicableIds = new Set(
          applicableMemories.map((memory) => memory.id),
        );
        if (result.usedMemoryIds.some((id) => !applicableIds.has(id))) {
          throw new Error(
            "The draft model cited a memory outside its supplied context.",
          );
        }

        const draft = await saveGeneratedDraft({
          userId: session.userId,
          accountId: context.accountId,
          threadId: context.id,
          text: result.text,
          usedMemoryIds: result.usedMemoryIds,
          modelId: result.modelId,
          schedulingRelevant: result.schedulingRelevant,
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
