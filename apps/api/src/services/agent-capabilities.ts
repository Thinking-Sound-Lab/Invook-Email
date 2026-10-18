import { v5 as uuidv5, validate as validateUuid } from "uuid";

import type { MailAgentCapabilities } from "@invook/ai";
import {
  validateGmailComposeDraftFields,
  type AgentDraftOutput,
  type AgentEmailInput,
  type AgentMailSearchOutput,
  type AgentSendOutput,
  type AgentThreadContent,
  type AgentThreadReadOutput,
  type AgentToolFailure,
  type GmailComposeDraftFields,
  type GmailComposeDraftSource,
} from "@invook/contracts";
import { buildEmailPlainText } from "@invook/contracts/email-plain-text";
import {
  getGmailReplyContext,
  getMailboxThreadDetail,
  GmailDraftWriteConflictError,
  markGmailAccountReconnectRequired,
} from "@invook/database";
import {
  formatGmailReplySubject,
  GmailApiError,
  GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
  isGoogleReauthenticationRequired,
} from "@invook/gmail";

import {
  GmailDraftWritePendingError,
  GmailForwardContextUnavailableError,
  GmailReplyContextUnavailableError,
  saveComposeDraft,
} from "./compose-drafts";
import { GmailDraftSendPendingError, sendComposeDraft } from "./compose-send";
import {
  getGmailProviderAccessForAccount,
  GmailProviderConfigurationError,
  GmailProviderReconnectRequiredError,
  type GmailProviderAccess,
} from "./gmail-provider";
import { searchMailForUser } from "./search";

/**
 * Namespace for idempotency keys derived from agent tool calls. A retried or
 * re-approved tool call maps to the same Gmail write instead of a second one.
 */
const AGENT_WRITE_NAMESPACE = "a3d768a9-d969-49b3-8bec-ab89c6428f83";
const SEARCH_RESULT_LIMIT = 10;
const SEARCH_PREVIEW_LIMIT = 400;
const THREAD_MESSAGE_LIMIT = 10;
const MESSAGE_BODY_LIMIT = 3_000;
const PROVIDER_DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

type StoredThread = NonNullable<
  Awaited<ReturnType<typeof getMailboxThreadDetail>>
>["thread"];

export interface AgentCapabilityDependencies {
  searchMail: typeof searchMailForUser;
  getThreadDetail: typeof getMailboxThreadDetail;
  getReplyContext: typeof getGmailReplyContext;
  getProviderAccess: typeof getGmailProviderAccessForAccount;
  saveDraft: typeof saveComposeDraft;
  sendDraft: typeof sendComposeDraft;
  markReconnectRequired: typeof markGmailAccountReconnectRequired;
}

const defaultDependencies: AgentCapabilityDependencies = {
  searchMail: searchMailForUser,
  getThreadDetail: getMailboxThreadDetail,
  getReplyContext: getGmailReplyContext,
  getProviderAccess: getGmailProviderAccessForAccount,
  saveDraft: saveComposeDraft,
  sendDraft: sendComposeDraft,
  markReconnectRequired: markGmailAccountReconnectRequired,
};

class AgentToolRejection extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AgentToolRejection";
  }
}

function failed(reason: string): AgentToolFailure {
  return { status: "failed", reason };
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Splits an address header on commas outside quoted names and angle brackets. */
export function splitAddressList(value: string): string[] {
  const addresses: string[] = [];
  let current = "";
  let isQuoted = false;
  let angleDepth = 0;
  for (const character of value) {
    if (character === '"') isQuoted = !isQuoted;
    if (!isQuoted && character === "<") angleDepth += 1;
    if (!isQuoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (character === "," && !isQuoted && angleDepth === 0) {
      if (current.trim()) addresses.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) addresses.push(current.trim());
  return addresses;
}

function headerAddresses(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string[] {
  return headers
    .filter((header) => header.name.toLowerCase() === name)
    .flatMap((header) => splitAddressList(header.value));
}

export function toAgentThreadContent(thread: StoredThread): AgentThreadContent {
  const messages = thread.messages.slice(-THREAD_MESSAGE_LIMIT);
  return {
    threadId: thread.id,
    accountId: thread.accountId,
    accountEmail: thread.accountEmail,
    subject: thread.subject,
    earlierMessageCount: thread.messages.length - messages.length,
    messages: messages.map((message) => {
      const body =
        message.bodyText.trim() ||
        (message.bodyHtml ? buildEmailPlainText(message.bodyHtml) : "");
      return {
        messageId: message.id,
        from: message.sender.raw || message.sender.email,
        to: headerAddresses(message.headers, "to"),
        cc: headerAddresses(message.headers, "cc"),
        sentAt: message.sentAt,
        isDraft: message.isDraft,
        body: clip(body.trim(), MESSAGE_BODY_LIMIT),
        attachmentFilenames: message.attachments.map(
          (attachment) => attachment.filename,
        ),
      };
    }),
  };
}

function describeProviderFailure(error: unknown): string | null {
  if (error instanceof AgentToolRejection) return error.reason;
  if (error instanceof GmailProviderConfigurationError) {
    return "Gmail writes are not configured on this Invook server.";
  }
  if (error instanceof GmailProviderReconnectRequiredError) {
    return "That Gmail account must be reconnected in Invook first.";
  }
  if (error instanceof GmailReplyContextUnavailableError) {
    return "The message being replied to is not available in this account.";
  }
  if (error instanceof GmailForwardContextUnavailableError) {
    return "The message being forwarded is not available in this account.";
  }
  if (
    error instanceof GmailDraftWritePendingError ||
    error instanceof GmailDraftSendPendingError
  ) {
    return "Gmail is still finishing an earlier attempt. Try again in a moment.";
  }
  if (error instanceof GmailDraftWriteConflictError) {
    return "This conflicts with an earlier attempt to save the same email.";
  }
  if (error instanceof GmailApiError) {
    if (error.status === 400) return "Gmail rejected this email.";
    if (error.status === 404) return "Gmail could not find that draft or message.";
    if (error.status === 0 || error.status === 429 || error.status >= 500) {
      return "Gmail is unavailable right now. Try again shortly.";
    }
    return "Gmail could not complete this request.";
  }
  return null;
}

/**
 * Binds the agent's tools to one signed-in user and conversation. Every read
 * and write is scoped by the server-resolved user ID; model output can only
 * name records that this scope then authorizes.
 */
export function createAgentCapabilities(
  scope: { userId: string; conversationId: string },
  dependencies: AgentCapabilityDependencies = defaultDependencies,
): MailAgentCapabilities {
  const writeKey = (toolCallId: string, purpose: string) =>
    uuidv5(`${scope.conversationId}:${toolCallId}:${purpose}`, AGENT_WRITE_NAMESPACE);

  async function getAccess(accountId: string): Promise<GmailProviderAccess> {
    if (!validateUuid(accountId)) {
      throw new AgentToolRejection("That Gmail account is not connected to Invook.");
    }
    const result = await dependencies.getProviderAccess({
      userId: scope.userId,
      accountId,
    });
    if (result.status === "not_found") {
      throw new AgentToolRejection("That Gmail account is not connected to Invook.");
    }
    return result.access;
  }

  function prepareEmail(input: AgentEmailInput): {
    fields: GmailComposeDraftFields;
    source: GmailComposeDraftSource;
  } {
    if (input.replyToMessageId && input.forwardOfMessageId) {
      throw new AgentToolRejection("An email can reply or forward, not both.");
    }
    for (const messageId of [input.replyToMessageId, input.forwardOfMessageId]) {
      if (messageId !== null && !validateUuid(messageId)) {
        throw new AgentToolRejection("That message is not available in this account.");
      }
    }
    if (input.draftId !== null && !PROVIDER_DRAFT_ID_PATTERN.test(input.draftId)) {
      throw new AgentToolRejection("That draft is not available.");
    }
    const source: GmailComposeDraftSource = input.forwardOfMessageId
      ? { forwardOfMessageId: input.forwardOfMessageId }
      : input.replyToMessageId
        ? { replyToMessageId: input.replyToMessageId }
        : {};
    const validation = validateGmailComposeDraftFields(
      {
        recipients: input.to,
        ccRecipients: input.cc,
        bccRecipients: input.bcc,
        subject: input.subject,
        body: input.body,
      },
      source,
    );
    if (!validation.valid) throw new AgentToolRejection(validation.error.message);
    return { fields: validation.fields, source };
  }

  async function writeDraft(
    input: AgentEmailInput,
    idempotencyKey: string,
  ): Promise<{ access: GmailProviderAccess; providerDraftId: string; providerThreadId: string }> {
    const { fields, source } = prepareEmail(input);
    const access = await getAccess(input.accountId);
    try {
      const result = await dependencies.saveDraft({
        userId: scope.userId,
        access,
        operation: input.draftId ? "update" : "create",
        idempotencyKey,
        fields,
        source,
        ...(input.draftId ? { providerDraftId: input.draftId } : {}),
      });
      return {
        access,
        providerDraftId: result.draft.providerDraftId,
        providerThreadId: result.draft.providerThreadId,
      };
    } catch (error) {
      await markReconnectIfRequired(error, access.accountId);
      throw error;
    }
  }

  async function markReconnectIfRequired(error: unknown, accountId: string) {
    if (error instanceof GmailApiError && isGoogleReauthenticationRequired(error)) {
      await dependencies.markReconnectRequired({
        accountId,
        errorCode: GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
      });
      throw new GmailProviderReconnectRequiredError({ cause: error });
    }
  }

  function toFailure(error: unknown, tool: string): AgentToolFailure {
    const reason = describeProviderFailure(error);
    if (reason) return failed(reason);
    console.error("api: agent tool failed", {
      conversationId: scope.conversationId,
      tool,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return failed("Invook could not complete this request.");
  }

  return {
    async resolveEmail(input) {
      if (
        !input.replyToMessageId ||
        !validateUuid(input.replyToMessageId) ||
        !validateUuid(input.accountId)
      ) {
        return input;
      }
      const replyContext = await dependencies.getReplyContext({
        userId: scope.userId,
        accountId: input.accountId,
        messageId: input.replyToMessageId,
      });
      return replyContext
        ? { ...input, subject: formatGmailReplySubject(replyContext.subject) }
        : input;
    },

    async searchMail(input): Promise<AgentMailSearchOutput> {
      const query = input.query.trim();
      if (!query) return failed("Search needs at least one keyword.");
      if (input.accountId !== null && !validateUuid(input.accountId)) {
        return failed("That Gmail account is not connected to Invook.");
      }
      const results = await dependencies.searchMail({
        userId: scope.userId,
        accountId: input.accountId,
        query,
        limit: SEARCH_RESULT_LIMIT,
      });
      return {
        status: "available",
        results: results.map((result) => ({
          accountId: result.accountId,
          threadId: result.threadId,
          messageId: result.messageId,
          subject: result.subject,
          sender: result.sender.raw || result.sender.email,
          sentAt: result.sentAt,
          preview: clip(
            (result.bodyPreview || result.snippet).replace(/\s+/g, " ").trim(),
            SEARCH_PREVIEW_LIMIT,
          ),
          attachmentFilenames: result.attachments.map(
            (attachment) => attachment.filename,
          ),
        })),
      };
    },

    async readThread(input): Promise<AgentThreadReadOutput> {
      if (!validateUuid(input.threadId)) return { status: "unavailable" };
      const detail = await dependencies.getThreadDetail(
        scope.userId,
        input.threadId,
      );
      return detail
        ? { status: "available", thread: toAgentThreadContent(detail.thread) }
        : { status: "unavailable" };
    },

    async saveDraft(input, { toolCallId }): Promise<AgentDraftOutput> {
      try {
        const draft = await writeDraft(input, writeKey(toolCallId, "draft"));
        return {
          status: "saved",
          accountId: draft.access.accountId,
          providerDraftId: draft.providerDraftId,
          providerThreadId: draft.providerThreadId,
        };
      } catch (error) {
        return toFailure(error, "saveDraft");
      }
    },

    async sendEmail(input, { toolCallId }): Promise<AgentSendOutput> {
      try {
        // The approved content is written to the draft first, so the message
        // Gmail sends is exactly the one the user approved.
        const draft = await writeDraft(input, writeKey(toolCallId, "send-draft"));
        try {
          const sent = await dependencies.sendDraft({
            userId: scope.userId,
            access: draft.access,
            idempotencyKey: writeKey(toolCallId, "send"),
            providerDraftId: draft.providerDraftId,
          });
          return {
            status: "sent",
            accountId: draft.access.accountId,
            providerMessageId: sent.message.providerMessageId,
            providerThreadId: sent.message.providerThreadId,
          };
        } catch (error) {
          await markReconnectIfRequired(error, draft.access.accountId);
          throw error;
        }
      } catch (error) {
        return toFailure(error, "sendEmail");
      }
    },
  };
}
