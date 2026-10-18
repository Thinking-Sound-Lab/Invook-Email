import { isToolUIPart } from "ai";

import type {
  AgentApprovalDecision,
  InvookAgentUIMessage,
} from "@invook/contracts";

type AgentMessagePart = InvookAgentUIMessage["parts"][number];

const NOT_APPROVED_REASON = "Not approved before the next message.";
const INTERRUPTED_SEND_TEXT =
  "This approved email was interrupted before Invook confirmed it was sent. Check Sent before sending it again.";

/**
 * An approval the user still has to act on: requested and undecided, or
 * decided but interrupted before the tool ran. `approved` is the stored
 * decision, or null while undecided.
 */
function openApproval(
  part: AgentMessagePart,
): { id: string; approved: boolean | null } | null {
  if (!isToolUIPart(part)) return null;
  if (part.state === "approval-requested" && !part.approval.isAutomatic) {
    return { id: part.approval.id, approved: null };
  }
  if (part.state === "approval-responded" && !part.approval.isAutomatic) {
    return { id: part.approval.id, approved: part.approval.approved };
  }
  return null;
}

/**
 * Records the user's decisions on the open approvals in the latest assistant
 * message. Only the decisions come from the client; the tool calls and their
 * inputs come from stored history, so a client can approve or decline a
 * pending request but never change what it would do.
 *
 * A decision that was stored but interrupted may be sent again unchanged,
 * which resumes the call under its original tool call ID; it can never be
 * reversed. Returns null unless every open approval receives exactly one
 * decision.
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
  const openApprovals = lastMessage.parts.flatMap((part) => {
    const approval = openApproval(part);
    return approval ? [approval] : [];
  });
  if (
    decisions.length === 0 ||
    decisionsById.size !== decisions.length ||
    openApprovals.length !== decisions.length ||
    openApprovals.some((approval) => {
      const approved = decisionsById.get(approval.id);
      return (
        approved === undefined ||
        (approval.approved !== null && approval.approved !== approved)
      );
    })
  ) {
    return null;
  }

  const parts = lastMessage.parts.map((part): AgentMessagePart => {
    if (!isToolUIPart(part) || !openApproval(part)) return part;
    if (part.state !== "approval-requested" && part.state !== "approval-responded") {
      return part;
    }
    const approved = decisionsById.get(part.approval.id);
    if (approved === undefined) return part;
    return {
      ...part,
      state: "approval-responded",
      approval: { id: part.approval.id, approved },
    };
  });
  return { ...lastMessage, parts };
}

/**
 * Settles approvals the user left open by moving on to a new message, so the
 * history sent to the model never holds a tool call without a result. An
 * undecided or declined send is recorded as not sent; an approved send that was
 * interrupted is recorded as unconfirmed, because Gmail may have sent it.
 *
 * Returns null when the message has no open approval.
 */
export function closeOpenApprovals(
  message: InvookAgentUIMessage,
): InvookAgentUIMessage | null {
  if (message.role !== "assistant" || !message.parts.some(openApproval)) {
    return null;
  }
  const parts = message.parts.map((part): AgentMessagePart => {
    if (!isToolUIPart(part) || !openApproval(part)) return part;
    if (part.state === "approval-requested") {
      return {
        ...part,
        state: "output-denied",
        approval: {
          id: part.approval.id,
          approved: false,
          reason: NOT_APPROVED_REASON,
        },
      };
    }
    if (part.state !== "approval-responded") return part;
    if (!part.approval.approved) {
      return {
        ...part,
        state: "output-denied",
        approval: { ...part.approval, approved: false },
      };
    }
    return {
      ...part,
      state: "output-error",
      errorText: INTERRUPTED_SEND_TEXT,
      approval: { ...part.approval, approved: true },
    };
  });
  return { ...message, parts };
}
