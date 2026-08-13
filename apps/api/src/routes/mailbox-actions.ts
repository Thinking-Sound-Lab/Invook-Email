import type { FastifyPluginAsync } from "fastify";

import {
  approveMailboxActionProposal,
  cancelMailboxActionProposal,
  getMailboxActionProposalForUser,
} from "@invook/database";

import {
  mutationAccessHooks,
  requireSession,
  requireUuidParameter,
} from "../access";
import { sendJson, sendProblem } from "../responses";
import { serializeMailboxActionProposal } from "../services/mailbox-actions";

type ProposalParams = { proposalId: string };

export function hasApprovalPayload(body: unknown): boolean {
  if (body === null || body === undefined) return false;
  return typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0;
}

export const registerMailboxActionRoutes: FastifyPluginAsync = async (api) => {
  api.get<{ Params: ProposalParams }>(
    "/v1/agent/actions/:proposalId",
    {
      onRequest: [
        requireSession,
        requireUuidParameter("proposalId", "Proposal ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const proposal = await getMailboxActionProposalForUser({
        userId: session.userId,
        proposalId: request.params.proposalId,
      });
      if (!proposal) {
        await sendProblem(request, reply, 404, "Mailbox action proposal not found");
        return;
      }
      await sendJson(reply, 200, { proposal: serializeMailboxActionProposal(proposal) });
    },
  );

  api.post<{ Params: ProposalParams; Body: unknown }>(
    "/v1/agent/actions/:proposalId/approve",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("proposalId", "Proposal ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (hasApprovalPayload(request.body)) {
        await sendProblem(
          request,
          reply,
          400,
          "Approval does not accept replacement action data",
        );
        return;
      }
      const result = await approveMailboxActionProposal({
        userId: session.userId,
        proposalId: request.params.proposalId,
      });
      if (!result.proposal) {
        await sendProblem(request, reply, 404, "Mailbox action proposal not found");
        return;
      }
      if (result.outcome === "cancelled") {
        await sendProblem(request, reply, 409, "Mailbox action proposal was cancelled");
        return;
      }
      await sendJson(reply, result.outcome === "approved" ? 202 : 200, {
        proposal: serializeMailboxActionProposal(result.proposal),
        duplicate: result.outcome === "already_approved",
      });
    },
  );

  api.post<{ Params: ProposalParams; Body: unknown }>(
    "/v1/agent/actions/:proposalId/cancel",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("proposalId", "Proposal ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (hasApprovalPayload(request.body)) {
        await sendProblem(
          request,
          reply,
          400,
          "Cancellation does not accept replacement action data",
        );
        return;
      }
      const result = await cancelMailboxActionProposal({
        userId: session.userId,
        proposalId: request.params.proposalId,
      });
      if (!result.proposal) {
        await sendProblem(request, reply, 404, "Mailbox action proposal not found");
        return;
      }
      if (
        result.outcome === "not_pending" &&
        result.proposal.status !== "cancelled"
      ) {
        await sendProblem(
          request,
          reply,
          409,
          "Mailbox action proposal is already executing",
        );
        return;
      }
      await sendJson(reply, 200, {
        proposal: serializeMailboxActionProposal(result.proposal),
      });
    },
  );
};
