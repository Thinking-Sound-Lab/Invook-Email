import { generateReplyDraft } from "@invook/ai";
import {
  getReplyDraftContext,
  saveGeneratedDraft,
} from "@invook/database";
import { extractEmailAddress } from "@invook/gmail";

function contactEmails(values: string[], accountEmail: string): Set<string> {
  return new Set(
    values
      .map(extractEmailAddress)
      .filter(
        (email) =>
          email.includes("@") && email !== accountEmail.toLowerCase(),
      ),
  );
}

export async function generateDraftForUser(input: {
  userId: string;
  threadId: string;
  instruction?: string;
}) {
  const context = await getReplyDraftContext(input.userId, input.threadId);
  if (!context) return null;

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
    instruction: input.instruction,
  });
  const applicableIds = new Set(applicableMemories.map((memory) => memory.id));
  if (result.usedMemoryIds.some((id) => !applicableIds.has(id))) {
    throw new Error("The draft model cited a memory outside its supplied context.");
  }
  return saveGeneratedDraft({
    userId: input.userId,
    accountId: context.accountId,
    threadId: context.id,
    text: result.text,
    usedMemoryIds: result.usedMemoryIds,
    modelId: result.modelId,
    schedulingRelevant: result.schedulingRelevant,
  });
}
