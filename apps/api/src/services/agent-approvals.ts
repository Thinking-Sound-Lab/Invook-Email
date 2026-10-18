import { isToolUIPart } from "ai";

import type {
  AgentApprovalDecision,
  InvookAgentUIMessage,
} from "@invook/contracts";

type AgentMessagePart = InvookAgentUIMessage["parts"][number];

function isPendingUserApproval(part: AgentMessagePart): boolean {
  return (
    isToolUIPart(part) &&
    part.state === "approval-requested" &&
    !part.approval.isAutomatic
  );
}

/**
 * Records the user's decisions on the approval requests in the latest
 * assistant message. Only the decisions come from the client; the tool calls
 * and their inputs come from stored history, so a client can approve or
 * decline a pending request but never change what it would do.
 *
 * Returns null unless every pending request receives exactly one decision.
 */
export function applyAgentApprovalDecisions(
  messages: InvookAgentUIMessage[],
  decisions: AgentApprovalDecision[],
): InvookAgentUIMessage | null {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "assistant") return null;
  const decisionsById = new Map(
    decisions.map((decision) => [decision.approvalId, decision.approved]),
  );
  const pendingCount = lastMessage.parts.filter(isPendingUserApproval).length;
  if (
    decisions.length === 0 ||
    decisionsById.size !== decisions.length ||
    pendingCount !== decisions.length
  ) {
    return null;
  }

  let appliedCount = 0;
  const parts = lastMessage.parts.map((part): AgentMessagePart => {
    if (!isToolUIPart(part) || !isPendingUserApproval(part)) return part;
    if (part.state !== "approval-requested") return part;
    const approved = decisionsById.get(part.approval.id);
    if (approved === undefined) return part;
    appliedCount += 1;
    return {
      ...part,
      state: "approval-responded",
      approval: { id: part.approval.id, approved },
    };
  });
  return appliedCount === decisions.length
    ? { ...lastMessage, parts }
    : null;
}
