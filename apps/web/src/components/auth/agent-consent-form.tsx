"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { submitAgentConsent } from "@/lib/api/mcp-connections";

export interface AgentConsentFormProps {
  agentName: string;
  canApprove: boolean;
}

export function AgentConsentForm({ agentName, canApprove }: AgentConsentFormProps) {
  const [pendingDecision, setPendingDecision] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDecision(isApproved: boolean) {
    setError(null);
    setPendingDecision(isApproved ? "allow" : "deny");
    try {
      // The query string is the authorization request Invook signed; the
      // server verifies it, so it is sent back exactly as received.
      const nextUrl = await submitAgentConsent({
        isApproved,
        oauthQuery: window.location.search.slice(1),
      });
      window.location.assign(nextUrl);
    } catch {
      setError(
        "Invook could not record your decision. Start connecting from your agent again.",
      );
      setPendingDecision(null);
    }
  }

  return (
    <div className="mt-8">
      <div className="flex gap-3">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-11 flex-1"
          disabled={pendingDecision !== null}
          onClick={() => void handleDecision(false)}
        >
          {pendingDecision === "deny" ? "Denying…" : "Deny"}
        </Button>
        {canApprove ? (
          <Button
            type="button"
            size="lg"
            className="h-11 flex-1"
            disabled={pendingDecision !== null}
            onClick={() => void handleDecision(true)}
            aria-label={`Allow ${agentName}`}
          >
            {pendingDecision === "allow" ? "Allowing…" : "Allow"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-3 text-center text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
