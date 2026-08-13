"use client";

import { Alert02Icon, Loading01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MailboxActionProposal } from "@invook/contracts";
import axios from "axios";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ProposalResponse = { proposal: MailboxActionProposal };

function operationLabel(proposal: MailboxActionProposal): string {
  switch (proposal.operation) {
    case "archive":
      return "Archive messages";
    case "mark_read":
      return "Mark messages as read";
    case "mark_unread":
      return "Mark messages as unread";
    case "trash":
      return "Move messages to Trash";
    case "apply_gmail_label":
      return `Apply Gmail label ${proposal.gmailLabel?.name ?? ""}`.trim();
    case "remove_gmail_label":
      return `Remove Gmail label ${proposal.gmailLabel?.name ?? ""}`.trim();
    case "save_draft_to_gmail":
      return "Save AI draft to Gmail";
  }
}

function statusLabel(proposal: MailboxActionProposal): string {
  switch (proposal.status) {
    case "pending":
      return "Waiting for approval";
    case "executing":
      return "Approved and queued";
    case "completed":
      return "Completed";
    case "partial_failure":
      return "Completed with some failures";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function formatTargetDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ActionProposalCard({
  initialProposal,
}: {
  initialProposal: MailboxActionProposal;
}) {
  const [proposal, setProposal] = useState(initialProposal);
  const [isExpanded, setIsExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<"approve" | "cancel" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const isTrash = proposal.operation === "trash";
  const isPending = proposal.status === "pending";
  const visibleTargets = isExpanded ? proposal.targets : proposal.targets.slice(0, 3);

  const updateProposal = async (action: "approve" | "cancel") => {
    setPendingAction(action);
    setError(null);
    try {
      const response = await axios.post<ProposalResponse>(
        `/v1/agent/actions/${proposal.id}/${action}`,
        null,
        { validateStatus: () => true },
      );
      if (response.status < 200 || response.status >= 300) {
        setError(
          action === "approve"
            ? "This proposal could not be approved."
            : "This proposal could not be cancelled.",
        );
        return;
      }
      setProposal(response.data.proposal);
    } catch {
      setError("The proposal service is unavailable.");
    } finally {
      setPendingAction(null);
    }
  };

  const approveButton = isTrash ? (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" disabled={pendingAction !== null}>
          Approve
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move these messages to Trash?</AlertDialogTitle>
          <AlertDialogDescription>
            This performs a Gmail mutation for exactly {proposal.targets.length}{" "}
            {proposal.targets.length === 1 ? "message" : "messages"}. Invook will
            not add messages that arrive later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep messages</AlertDialogCancel>
          <AlertDialogAction onClick={() => void updateProposal("approve")}>
            Move to Trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : (
    <Button size="sm" onClick={() => void updateProposal("approve")} disabled={pendingAction !== null}>
      Approve
    </Button>
  );

  return (
    <section
      aria-label="Mailbox action proposal"
      className={cn(
        "my-2 rounded-xl bg-secondary/65 p-3 text-foreground",
        isTrash && "bg-destructive/10",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{operationLabel(proposal)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {proposal.targets.length} {proposal.targets.length === 1 ? "target" : "targets"}
            {" · "}
            {statusLabel(proposal)}
          </p>
        </div>
        {isTrash ? (
          <HugeiconsIcon
            icon={Alert02Icon}
            size={16}
            className="shrink-0 text-destructive"
          />
        ) : null}
      </div>

      {isTrash ? (
        <p className="mt-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          Approval moves the exact listed messages to Gmail Trash.
        </p>
      ) : null}

      <div className="mt-3 space-y-1.5">
        {visibleTargets.map((target) => (
          <div key={target.id} className="rounded-md bg-background/55 px-2.5 py-2">
            <p className="truncate text-xs font-medium">
              {target.subject || "(No subject)"}
            </p>
            {target.sender || target.sentAt ? (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {[target.sender, target.sentAt ? formatTargetDate(target.sentAt) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {proposal.targets.length > 3 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setIsExpanded((value) => !value)}
        >
          {isExpanded ? "Show representative targets" : `Show all ${proposal.targets.length} targets`}
        </Button>
      ) : null}

      {isPending ? (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pendingAction !== null}
            onClick={() => void updateProposal("cancel")}
          >
            Cancel
          </Button>
          {approveButton}
        </div>
      ) : null}
      {pendingAction ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="motion-safe:animate-spin">
            <HugeiconsIcon icon={Loading01Icon} size={12} />
          </span>
          {pendingAction === "approve" ? "Queuing approved action" : "Cancelling proposal"}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
