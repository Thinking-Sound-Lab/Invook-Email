import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { v4 as uuidv4, validate as validateUuid } from "uuid";
import { z } from "zod";

import type { MailAgentCapabilities } from "@invook/ai";
import type {
  AgentEmailInput,
  AgentToolFailure,
  MailboxView,
} from "@invook/contracts";
import {
  getGmailThreadMutationContext,
  getMailboxShellData,
  listMailboxThreads,
  parseMailboxCursor,
} from "@invook/database";

import {
  createAgentCapabilities,
  describeProviderFailure,
  type AgentCapabilityScope,
} from "../services/agent-capabilities";
import {
  applyGmailThreadAction,
  gmailThreadActions,
} from "../services/gmail-thread-actions";
import { getGmailProviderAccessForAccount } from "../services/gmail-provider";
import { MCP_SERVER_INSTRUCTIONS } from "./mcp-instructions";

/** The user and agent one verified MCP request speaks for. */
export interface McpIdentity {
  userId: string;
  clientId: string;
}

export interface McpServerDependencies {
  createCapabilities: (scope: AgentCapabilityScope) => MailAgentCapabilities;
  getShell: typeof getMailboxShellData;
  listThreads: typeof listMailboxThreads;
  getThreadContext: typeof getGmailThreadMutationContext;
  getProviderAccess: typeof getGmailProviderAccessForAccount;
  applyThreadAction: typeof applyGmailThreadAction;
  /**
   * Identifies one tool call's Gmail writes. MCP has no call identity that is
   * stable across a client's retries, so each call gets a fresh one rather
   * than risk two different emails sharing an idempotency key.
   */
  generateToolCallId: () => string;
}

const defaultDependencies: McpServerDependencies = {
  createCapabilities: createAgentCapabilities,
  getShell: getMailboxShellData,
  listThreads: listMailboxThreads,
  getThreadContext: getGmailThreadMutationContext,
  getProviderAccess: getGmailProviderAccessForAccount,
  applyThreadAction: applyGmailThreadAction,
  generateToolCallId: uuidv4,
};

const SERVER_VERSION = "0.2.0";
const UNAVAILABLE_REASON = "Invook could not complete this request.";
const ACCOUNT_UNAVAILABLE_REASON = "That Gmail account is not connected to Invook.";
const NO_ACCOUNTS_REASON =
  "No Gmail account is connected to Invook yet. The user can connect one in Invook.";

const threadViews = {
  inbox: "all",
  important: "important",
  starred: "starred",
  drafts: "drafts",
  sent: "sent",
  spam: "spam",
  trash: "trash",
} as const satisfies Record<string, MailboxView>;

const identifier = (description: string) =>
  z.string().min(1).max(256).describe(description);

const recipients = (description: string) =>
  z.array(z.string().min(3).max(254)).max(50).describe(description);

const listThreadsInputSchema = z
  .object({
    view: z
      .enum(["inbox", "important", "starred", "drafts", "sent", "spam", "trash"])
      .default("inbox")
      .describe("The mailbox view to list. Defaults to the Inbox."),
    labelId: identifier(
      "An Invook label ID from list_accounts, to list threads with that label instead of a view.",
    ).optional(),
    accountId: identifier(
      "A connected account ID from list_accounts, to list one account. Omit it for every account.",
    ).optional(),
    cursor: z
      .string()
      .min(1)
      .max(1_024)
      .optional()
      .describe("The nextCursor from an earlier list_threads call, to list older threads."),
  })
  .strict();

const searchMailInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Plain keywords: names, addresses, subject words, or attachment filename words. Gmail operators such as from: are not supported.",
      ),
    accountId: identifier(
      "A connected account ID from list_accounts, to search one account. Omit it for every account.",
    ).optional(),
  })
  .strict();

const readThreadInputSchema = z
  .object({
    threadId: identifier("A threadId returned by list_threads or search_mail."),
  })
  .strict();

const emailInputSchema = z
  .object({
    accountId: identifier("The connected account ID, from list_accounts, that sends the email."),
    to: recipients("Bare email addresses, such as name@example.com."),
    cc: recipients("Bare email addresses to copy.").default([]),
    bcc: recipients("Bare email addresses to blind copy.").default([]),
    subject: z
      .string()
      .max(998)
      .default("")
      .describe("The subject. Replies keep the thread's subject automatically."),
    body: z
      .string()
      .max(10_000)
      .describe("Plain-text body in the user's voice. No Markdown."),
    replyToMessageId: identifier(
      "The messageId, from read_thread, of the message being replied to.",
    ).optional(),
    forwardOfMessageId: identifier(
      "The messageId, from read_thread, of the message being forwarded. Invook appends the original message.",
    ).optional(),
    draftId: identifier(
      "The providerDraftId returned by save_draft, to revise that draft instead of creating another.",
    ).optional(),
  })
  .strict();

const updateThreadInputSchema = z
  .object({
    threadId: identifier("A threadId returned by list_threads or search_mail."),
    action: z
      .enum(gmailThreadActions)
      .describe("mark_read, mark_unread, or archive (remove from the Inbox)."),
  })
  .strict();

function toolResult(output: object, options: { isError?: boolean } = {}): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    ...(options.isError ? { isError: true } : {}),
  };
}

function failed(reason: string): CallToolResult {
  const failure: AgentToolFailure = { status: "failed", reason };
  return toolResult(failure, { isError: true });
}

/** Failed tool outputs carry `status: "failed"`; every other status succeeded. */
function capabilityResult(output: { status: string }): CallToolResult {
  return toolResult(output, { isError: output.status === "failed" });
}

function toAgentEmail(input: z.output<typeof emailInputSchema>): AgentEmailInput {
  return {
    accountId: input.accountId,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    replyToMessageId: input.replyToMessageId ?? null,
    forwardOfMessageId: input.forwardOfMessageId ?? null,
    draftId: input.draftId ?? null,
  };
}

/**
 * Builds the MCP server for one verified request. Every tool is bound to the
 * user resolved from the access token; tool arguments can only name records
 * that this user's scope then authorizes.
 */
export function createInvookMcpServer(
  identity: McpIdentity,
  dependencies: McpServerDependencies = defaultDependencies,
): McpServer {
  const server = new McpServer(
    { name: "invook", title: "Invook", version: SERVER_VERSION },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const capabilities = dependencies.createCapabilities({
    userId: identity.userId,
    writeScopeId: identity.clientId,
    // Agent pane turns hold a conversation lease; an MCP call has none to lose.
    ensureRunActive: () => Promise.resolve(true),
  });

  async function runTool(
    tool: string,
    execute: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    try {
      return await execute();
    } catch (error) {
      const reason = describeProviderFailure(error);
      if (reason) return failed(reason);
      console.error("api: mcp tool failed", {
        clientId: identity.clientId,
        tool,
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return failed(UNAVAILABLE_REASON);
    }
  }

  server.registerTool(
    "list_accounts",
    {
      title: "List Gmail accounts",
      description:
        "List the user's Gmail accounts connected to Invook, with their account IDs, connection status, and Invook labels.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool("list_accounts", async () => {
        const shell = await dependencies.getShell(identity.userId);
        const labelsByAccountId = new Map(
          (shell?.accountLabels ?? []).map((entry) => [entry.accountId, entry.labels]),
        );
        const accounts = (shell?.accounts ?? []).flatMap((account) =>
          account.status === "disconnected"
            ? []
            : [
                {
                  accountId: account.id,
                  email: account.email,
                  status: account.status,
                  labels: (labelsByAccountId.get(account.id) ?? [])
                    .filter((label) => label.isEnabled)
                    .map((label) => ({
                      labelId: label.id,
                      name: label.name,
                      description: label.description,
                    })),
                },
              ],
        );
        return toolResult({ accounts });
      }),
  );

  server.registerTool(
    "list_threads",
    {
      title: "List email threads",
      description:
        "List the user's email threads, newest first, from a mailbox view or an Invook label across connected accounts. Returns up to one page and a nextCursor for older threads.",
      inputSchema: listThreadsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      runTool("list_threads", async () => {
        if (input.accountId !== undefined && !validateUuid(input.accountId)) {
          return failed(ACCOUNT_UNAVAILABLE_REASON);
        }
        if (input.labelId !== undefined && !validateUuid(input.labelId)) {
          return failed("That Invook label does not exist.");
        }
        const cursor = input.cursor ? parseMailboxCursor(input.cursor) : null;
        if (input.cursor && !cursor) return failed("That cursor is not valid.");
        const page = await dependencies.listThreads(identity.userId, {
          accountId: input.accountId ?? null,
          cursor,
          view: input.labelId ? `label:${input.labelId}` : threadViews[input.view],
        });
        if (!page) {
          return failed(input.accountId ? ACCOUNT_UNAVAILABLE_REASON : NO_ACCOUNTS_REASON);
        }
        return toolResult({
          threads: page.threads.map((thread) => ({
            threadId: thread.id,
            accountId: thread.accountId,
            accountEmail: thread.accountEmail,
            subject: thread.subject,
            snippet: thread.snippet,
            participants: thread.participants,
            isUnread: thread.isUnread,
            isStarred: thread.isStarred,
            isDraft: thread.isDraft,
            invookLabel: thread.invookLabel?.name ?? null,
            latestMessageAt: thread.latestMessageAt,
            messageCount: thread.messageCount,
          })),
          nextCursor: page.pagination.olderCursor,
        });
      }),
  );

  server.registerTool(
    "search_mail",
    {
      title: "Search mail",
      description:
        "Search the user's stored mail across connected Gmail accounts. Matches message text, subjects, senders, recipients, and attachment filenames, and returns up to 10 messages.",
      inputSchema: searchMailInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      runTool("search_mail", async () =>
        capabilityResult(
          await capabilities.searchMail({
            query: input.query,
            accountId: input.accountId ?? null,
          }),
        ),
      ),
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read a thread",
      description:
        "Read the latest messages of one email thread, including the message IDs needed to reply or forward.",
      inputSchema: readThreadInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      runTool("read_thread", async () => {
        const output = await capabilities.readThread({ threadId: input.threadId });
        return output.status === "available"
          ? toolResult(output)
          : failed("That thread is not available in Invook.");
      }),
  );

  server.registerTool(
    "save_draft",
    {
      title: "Save a Gmail draft",
      description:
        "Save an email as a Gmail draft without sending it. The draft appears in the user's Gmail for review. Use it for replies, forwards, and new email.",
      inputSchema: emailInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool("save_draft", async () => {
        const email = await capabilities.resolveEmail(toAgentEmail(input));
        return capabilityResult(
          await capabilities.saveDraft(email, {
            toolCallId: dependencies.generateToolCallId(),
          }),
        );
      }),
  );

  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description:
        "Send an email from a connected Gmail account. Use only when the user explicitly asks to send, after showing them the recipients, subject, and body. Sending cannot be undone.",
      inputSchema: emailInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) =>
      runTool("send_email", async () => {
        const email = await capabilities.resolveEmail(toAgentEmail(input));
        return capabilityResult(
          await capabilities.sendEmail(email, {
            toolCallId: dependencies.generateToolCallId(),
          }),
        );
      }),
  );

  server.registerTool(
    "update_thread",
    {
      title: "Update a thread",
      description:
        "Mark an email thread read or unread, or archive it out of the Inbox, in the user's Gmail.",
      inputSchema: updateThreadInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool("update_thread", async () => {
        const unavailable = "That thread is not available in Invook.";
        if (!validateUuid(input.threadId)) return failed(unavailable);
        const context = await dependencies.getThreadContext({
          userId: identity.userId,
          threadId: input.threadId,
        });
        if (!context) return failed(unavailable);
        const access = await dependencies.getProviderAccess({
          userId: identity.userId,
          accountId: context.accountId,
        });
        if (access.status === "not_found") return failed(ACCOUNT_UNAVAILABLE_REASON);
        const result = await dependencies.applyThreadAction({
          userId: identity.userId,
          access: access.access,
          context,
          action: input.action,
        });
        if (result.status === "not_found") return failed(unavailable);
        return toolResult({
          status: "updated",
          threadId: input.threadId,
          action: input.action,
        });
      }),
  );

  return server;
}
