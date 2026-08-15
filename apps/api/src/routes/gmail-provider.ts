import type { FastifyPluginAsync } from "fastify";

import {
  enqueueGmailHistoryCatchup,
  GmailDraftWriteConflictError,
  getAiReplyDraftForGmailSave,
  getGmailDraftResourceForUser,
  getGmailMessageLabelMutationContext,
  getGmailThreadLabelMutationContext,
  getGmailProviderLabelForUser,
} from "@invook/database";
import {
  createGmailLabel,
  deleteGmailDraft,
  deleteGmailLabel,
  GmailApiError,
  modifyGmailMessageLabels,
  modifyGmailThreadLabels,
  trashGmailMessage,
  updateGmailDraft,
  updateGmailLabel,
  type GmailLabelInput,
} from "@invook/gmail";

import {
  isUuid,
  mutationAccessHooks,
  requireUuidParameter,
} from "../access";
import { sendJson, sendProblem } from "../responses";
import type { GmailProviderAccess } from "../services/gmail-provider";
import { GmailDraftWritePendingError } from "../services/compose-drafts";
import {
  GmailReplyComposeError,
  promoteReplyDraftToGmail,
} from "../services/promote-reply-draft";
import {
  getGmailProviderAccessForRequest,
  sendGmailWriteProblem,
} from "./gmail-provider-access";

type GmailLabelParams = { gmailLabelId: string };
type GmailMessageParams = { messageId: string };
type GmailThreadParams = { threadId: string };
type GmailDraftParams = { gmailDraftId: string };
type AiDraftParams = { draftId: string };

const messageListVisibilities = new Set(["hide", "show"]);
const labelListVisibilities = new Set([
  "labelHide",
  "labelShow",
  "labelShowIfUnread",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseGmailLabelInput(
  body: unknown,
  options: { requireName: boolean },
): GmailLabelInput | Partial<GmailLabelInput> | null {
  if (!isRecord(body)) return null;
  const input: Partial<GmailLabelInput> = {};
  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) return null;
    input.name = body.name.trim();
  } else if (options.requireName) {
    return null;
  }
  if ("messageListVisibility" in body) {
    if (
      typeof body.messageListVisibility !== "string" ||
      !messageListVisibilities.has(body.messageListVisibility)
    ) {
      return null;
    }
    input.messageListVisibility = body.messageListVisibility as
      | "hide"
      | "show";
  }
  if ("labelListVisibility" in body) {
    if (
      typeof body.labelListVisibility !== "string" ||
      !labelListVisibilities.has(body.labelListVisibility)
    ) {
      return null;
    }
    input.labelListVisibility = body.labelListVisibility as
      | "labelHide"
      | "labelShow"
      | "labelShowIfUnread";
  }
  if ("color" in body) {
    if (!isRecord(body.color)) return null;
    const textColor = body.color.textColor;
    const backgroundColor = body.color.backgroundColor;
    if (
      typeof textColor !== "string" ||
      !textColor.trim() ||
      typeof backgroundColor !== "string" ||
      !backgroundColor.trim()
    ) {
      return null;
    }
    input.color = {
      textColor: textColor.trim(),
      backgroundColor: backgroundColor.trim(),
    };
  }
  return Object.keys(input).length > 0 ? input : null;
}

function parseUuidArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }
  const values = value as string[];
  if (values.some((entry) => !isUuid(entry))) return null;
  return [...new Set(values)];
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
      changes: { addLabelIds?: string[]; removeLabelIds?: string[] };
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
  ) return null;
  return gmailMessageActions.find((action) => action === body.action) ?? null;
}

function resolveProviderLabelIds(
  labelIds: string[],
  providerLabelsById: Map<string, string>,
): string[] {
  return labelIds.flatMap((labelId) => {
    const providerLabelId = providerLabelsById.get(labelId);
    return providerLabelId ? [providerLabelId] : [];
  });
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
  api.post<{ Body: unknown }>(
    "/v1/gmail/labels",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const label = parseGmailLabelInput(request.body, { requireName: true });
      if (!label || !("name" in label) || !label.name) {
        await sendProblem(request, reply, 400, "Gmail label input is invalid");
        return;
      }
      const access = await getGmailProviderAccessForRequest(request, reply);
      if (!access) return;
      try {
        const created = await createGmailLabel(access.accessToken, label as GmailLabelInput);
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 201, { label: created, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.patch<{ Params: GmailLabelParams; Body: unknown }>(
    "/v1/gmail/labels/:gmailLabelId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("gmailLabelId", "Gmail label ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const changes = parseGmailLabelInput(request.body, { requireName: false });
      if (!changes) {
        await sendProblem(request, reply, 400, "Gmail label input is invalid");
        return;
      }
      const [access, label] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getGmailProviderLabelForUser({
          userId: session.userId,
          gmailLabelId: request.params.gmailLabelId,
        }),
      ]);
      if (!access) return;
      if (!label || label.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Gmail label not found");
        return;
      }
      if (label.type !== "user") {
        await sendProblem(request, reply, 409, "System Gmail labels cannot be changed");
        return;
      }
      try {
        const updated = await updateGmailLabel(
          access.accessToken,
          label.providerLabelId,
          changes,
        );
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { label: updated, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.delete<{ Params: GmailLabelParams }>(
    "/v1/gmail/labels/:gmailLabelId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("gmailLabelId", "Gmail label ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const [access, label] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getGmailProviderLabelForUser({
          userId: session.userId,
          gmailLabelId: request.params.gmailLabelId,
        }),
      ]);
      if (!access) return;
      if (!label || label.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Gmail label not found");
        return;
      }
      if (label.type !== "user") {
        await sendProblem(request, reply, 409, "System Gmail labels cannot be changed");
        return;
      }
      try {
        await deleteGmailLabel(access.accessToken, label.providerLabelId);
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 202, { deleted: true, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.patch<{ Params: GmailMessageParams; Body: unknown }>(
    "/v1/gmail/messages/:messageId/labels",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("messageId", "Message ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (!isRecord(request.body)) {
        await sendProblem(request, reply, 400, "Gmail label mutation is invalid");
        return;
      }
      const addLabelIds = parseUuidArray(request.body.addLabelIds);
      const removeLabelIds = parseUuidArray(request.body.removeLabelIds);
      if (
        !addLabelIds ||
        !removeLabelIds ||
        (addLabelIds.length === 0 && removeLabelIds.length === 0) ||
        addLabelIds.some((labelId) => removeLabelIds.includes(labelId))
      ) {
        await sendProblem(request, reply, 400, "Gmail label mutation is invalid");
        return;
      }
      const gmailLabelIds = [...new Set([...addLabelIds, ...removeLabelIds])];
      const [access, context] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getGmailMessageLabelMutationContext({
          userId: session.userId,
          messageId: request.params.messageId,
          gmailLabelIds,
        }),
      ]);
      if (!access) return;
      if (!context || context.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Gmail message or label not found");
        return;
      }
      const providerLabels = new Map(
        context.labels.map((label) => [label.id, label.providerLabelId]),
      );
      try {
        const message = await modifyGmailMessageLabels(
          access.accessToken,
          context.providerMessageId,
          {
            addLabelIds: resolveProviderLabelIds(addLabelIds, providerLabels),
            removeLabelIds: resolveProviderLabelIds(removeLabelIds, providerLabels),
          },
        );
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { message, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.patch<{ Params: GmailThreadParams; Body: unknown }>(
    "/v1/gmail/threads/:threadId/labels",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("threadId", "Thread ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (!isRecord(request.body)) {
        await sendProblem(request, reply, 400, "Gmail label mutation is invalid");
        return;
      }
      const addLabelIds = parseUuidArray(request.body.addLabelIds);
      const removeLabelIds = parseUuidArray(request.body.removeLabelIds);
      if (
        !addLabelIds ||
        !removeLabelIds ||
        (addLabelIds.length === 0 && removeLabelIds.length === 0) ||
        addLabelIds.some((labelId) => removeLabelIds.includes(labelId))
      ) {
        await sendProblem(request, reply, 400, "Gmail label mutation is invalid");
        return;
      }
      const [access, context] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getGmailThreadLabelMutationContext({
          userId: session.userId,
          threadId: request.params.threadId,
          gmailLabelIds: [...new Set([...addLabelIds, ...removeLabelIds])],
        }),
      ]);
      if (!access) return;
      if (!context || context.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Gmail thread or label not found");
        return;
      }
      const providerLabels = new Map(
        context.labels.map((label) => [label.id, label.providerLabelId]),
      );
      try {
        const thread = await modifyGmailThreadLabels(
          access.accessToken,
          context.providerThreadId,
          {
            addLabelIds: resolveProviderLabelIds(addLabelIds, providerLabels),
            removeLabelIds: resolveProviderLabelIds(removeLabelIds, providerLabels),
          },
        );
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { thread, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
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
      const [access, context] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getGmailMessageLabelMutationContext({
          userId: session.userId,
          messageId: request.params.messageId,
          gmailLabelIds: [],
        }),
      ]);
      if (!access) return;
      if (!context || context.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Gmail message not found");
        return;
      }
      try {
        const mutation = gmailMessageActionMutation(action);
        const message = mutation.kind === "trash"
          ? await trashGmailMessage(access.accessToken, context.providerMessageId)
          : await modifyGmailMessageLabels(
              access.accessToken,
              context.providerMessageId,
              mutation.changes,
            );
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { message, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.put<{ Params: GmailDraftParams; Body: unknown }>(
    "/v1/gmail/drafts/:gmailDraftId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("gmailDraftId", "Gmail draft ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const rawRfc2822 =
        isRecord(request.body) && "rawRfc2822" in request.body
          ? request.body.rawRfc2822
          : null;
      if (typeof rawRfc2822 !== "string" || !rawRfc2822.trim()) {
        await sendProblem(request, reply, 400, "Raw RFC 2822 draft is required");
        return;
      }
      const [access, draft] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getGmailDraftResourceForUser({
          userId: session.userId,
          gmailDraftId: request.params.gmailDraftId,
        }),
      ]);
      if (!access) return;
      if (!draft || draft.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Gmail draft not found");
        return;
      }
      try {
        const updated = await updateGmailDraft(
          access.accessToken,
          draft.providerDraftId,
          {
            raw: Buffer.from(rawRfc2822, "utf8"),
            threadId: draft.providerThreadId,
          },
        );
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { draft: updated, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.delete<{ Params: GmailDraftParams }>(
    "/v1/gmail/drafts/:gmailDraftId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("gmailDraftId", "Gmail draft ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const [access, draft] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getGmailDraftResourceForUser({
          userId: session.userId,
          gmailDraftId: request.params.gmailDraftId,
        }),
      ]);
      if (!access) return;
      if (!draft || draft.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Gmail draft not found");
        return;
      }
      try {
        await deleteGmailDraft(access.accessToken, draft.providerDraftId);
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 202, { deleted: true, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.post<{ Params: AiDraftParams }>(
    "/v1/drafts/:draftId/save-to-gmail",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("draftId", "Draft ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const [access, draft] = await Promise.all([
        getGmailProviderAccessForRequest(request, reply),
        getAiReplyDraftForGmailSave({
          userId: session.userId,
          draftId: request.params.draftId,
        }),
      ]);
      if (!access) return;
      if (!draft || draft.accountId !== access.accountId) {
        await sendProblem(request, reply, 404, "Draft not found");
        return;
      }
      if (!draft.replyTarget) {
        await sendProblem(request, reply, 409, "Draft has no incoming message to reply to");
        return;
      }
      try {
        const result = await promoteReplyDraftToGmail({
          userId: session.userId,
          access,
          draftId: draft.id,
          updatedAt: draft.updatedAt,
          accountEmail: draft.accountEmail,
          providerThreadId: draft.providerThreadId,
          subject: draft.subject,
          currentText: draft.currentText,
          replyTarget: draft.replyTarget,
        });
        await sendJson(reply, 201, result);
      } catch (error) {
        if (error instanceof GmailReplyComposeError) {
          await sendProblem(request, reply, 409, "Draft has no valid reply recipient");
          return;
        }
        if (error instanceof GmailDraftWriteConflictError) {
          await sendProblem(request, reply, 409, "Draft version conflicts with another Gmail write");
          return;
        }
        if (error instanceof GmailDraftWritePendingError) {
          await sendProblem(request, reply, 409, "Previous Gmail draft save is still being resolved");
          return;
        }
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );
};
