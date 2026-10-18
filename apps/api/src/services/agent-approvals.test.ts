import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentApprovalDecision,
  AgentEmailInput,
  InvookAgentUIMessage,
} from "@invook/contracts";

import { applyAgentApprovalDecisions } from "./agent-approvals";

const email: AgentEmailInput = {
  accountId: "22222222-2222-4222-8222-222222222222",
  to: ["recipient@example.com"],
  cc: [],
  bcc: [],
  subject: "Re: Contract",
  body: "Signed and attached.",
  replyToMessageId: "33333333-3333-4333-8333-333333333333",
  forwardOfMessageId: null,
  draftId: null,
};

function pendingSend(approvalId: string, isAutomatic = false) {
  return {
    type: "tool-sendEmail" as const,
    toolCallId: `call-${approvalId}`,
    state: "approval-requested" as const,
    input: email,
    approval: { id: approvalId, ...(isAutomatic ? { isAutomatic } : {}) },
  };
}

const history: InvookAgentUIMessage[] = [
  {
    id: "user-message",
    role: "user",
    parts: [{ type: "text", text: "Send the reply." }],
  },
  {
    id: "assistant-message",
    role: "assistant",
    parts: [{ type: "text", text: "Here is the reply." }, pendingSend("approval-1")],
  },
];

test("a decision answers the pending request without changing its email", () => {
  const decided = applyAgentApprovalDecisions(history, [
    { approvalId: "approval-1", approved: true },
  ]);

  assert.deepEqual(decided, {
    ...history[1],
    parts: [
      { type: "text", text: "Here is the reply." },
      {
        type: "tool-sendEmail",
        toolCallId: "call-approval-1",
        state: "approval-responded",
        input: email,
        approval: { id: "approval-1", approved: true },
      },
    ],
  });
});

test("decisions that do not answer exactly the pending requests are refused", () => {
  const twoPending: InvookAgentUIMessage[] = [
    history[0]!,
    {
      ...history[1]!,
      parts: [pendingSend("approval-1"), pendingSend("approval-2")],
    },
  ];

  const cases: Array<[InvookAgentUIMessage[], AgentApprovalDecision[]]> = [
    [history, []],
    [history, [{ approvalId: "approval-unknown", approved: true }]],
    [
      history,
      [
        { approvalId: "approval-1", approved: true },
        { approvalId: "approval-1", approved: false },
      ],
    ],
    [twoPending, [{ approvalId: "approval-1", approved: true }]],
    [history.slice(0, 1), [{ approvalId: "approval-1", approved: true }]],
    [
      [history[0]!, { ...history[1]!, parts: [pendingSend("approval-1", true)] }],
      [{ approvalId: "approval-1", approved: true }],
    ],
  ];
  for (const [messages, decisions] of cases) {
    assert.equal(applyAgentApprovalDecisions(messages, decisions), null);
  }
});

test("an already decided request cannot be decided again", () => {
  const decided = applyAgentApprovalDecisions(history, [
    { approvalId: "approval-1", approved: false },
  ]);
  assert.ok(decided);

  assert.equal(
    applyAgentApprovalDecisions([history[0]!, decided], [
      { approvalId: "approval-1", approved: true },
    ]),
    null,
  );
});
