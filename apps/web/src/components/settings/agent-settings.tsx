"use client";

import type { McpConnection, McpConnectionsResponse } from "@invook/contracts";
import { useEffect, useState } from "react";

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
import { disconnectMcpConnection, getMcpConnections } from "@/lib/api/mcp-connections";
import { apiErrorMessage } from "@/lib/http-error";

import { AgentSetupGuides } from "./agent-setup-guides";
import { CopyValueButton } from "./copy-value-button";

type AgentSettingsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "available"; data: McpConnectionsResponse };

async function loadAgentSettings(): Promise<AgentSettingsState> {
  try {
    return { status: "available", data: await getMcpConnections() };
  } catch {
    return { status: "error" };
  }
}

const connectedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Agents choose their own names, so the client ID tells two installations apart. */
const CLIENT_ID_PREFIX_LENGTH = 8;

interface ConnectedAgentRowProps {
  connection: McpConnection;
  isPending: boolean;
  isDisabled: boolean;
  onDisconnect: () => void;
}

function ConnectedAgentRow({
  connection,
  isPending,
  isDisabled,
  onDisconnect,
}: ConnectedAgentRowProps) {
  const name = connection.name ?? "Unnamed agent";
  const detail = `Connected ${connectedAtFormat.format(new Date(connection.connectedAt))} · ID ${connection.clientId.slice(0, CLIENT_ID_PREFIX_LENGTH)}`;
  return (
    <article className="flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/35">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold">{name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isDisabled}
            className="text-xs text-muted-foreground"
          >
            {isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {detail}. It loses access to your mail on its next request. Drafts
              and email it already wrote stay in Gmail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="border-0">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDisconnect}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}

export function AgentSettings() {
  const [state, setState] = useState<AgentSettingsState>({ status: "loading" });
  const [pendingClientId, setPendingClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    void loadAgentSettings().then((nextState) => {
      if (isCurrent) setState(nextState);
    });
    return () => {
      isCurrent = false;
    };
  }, []);

  async function handleRetry() {
    setState({ status: "loading" });
    setState(await loadAgentSettings());
  }

  async function handleDisconnect(clientId: string) {
    if (pendingClientId !== null) return;
    setPendingClientId(clientId);
    setError(null);
    try {
      await disconnectMcpConnection(clientId);
      setState(await loadAgentSettings());
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not disconnect this agent."));
    } finally {
      setPendingClientId(null);
    }
  }

  return (
    <section className="w-full px-5 py-6 pr-12 sm:px-8 sm:py-7 sm:pr-12">
      <h2 className="text-lg font-semibold tracking-[-0.025em]">Agents</h2>
      <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">
        Connect Claude, ChatGPT, Cursor, and other AI agents to Invook. They read,
        organize, draft, and send mail in the Gmail accounts connected here, after
        you approve each one.
      </p>

      {state.status === "loading" ? (
        <p className="mt-7 text-sm text-muted-foreground" role="status">
          Loading agent setup
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="mt-7" role="alert">
          <p className="text-sm font-medium">Agent setup is unavailable</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => void handleRetry()}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {state.status === "available" ? (
        <>
          <div className="mt-7 rounded-xl bg-card/65 p-5">
            <h3 className="text-sm font-semibold">Set up with one paste</h3>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Copy the Invook skill and paste it into Claude Code, Codex, or
              Cursor. The agent connects itself and saves the skill; you approve
              it in your browser.
            </p>
            <div className="mt-4">
              <CopyValueButton value={state.data.skill} label="Copy skill" />
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-card/65 p-5">
            <h3 className="text-sm font-semibold">Server URL</h3>
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-background/55 px-3 py-2.5">
              <code className="min-w-0 flex-1 break-all font-sans text-xs leading-5 text-foreground">
                {state.data.serverUrl}
              </code>
              <CopyValueButton value={state.data.serverUrl} label="Copy" />
            </div>
            <div className="mt-5">
              <AgentSetupGuides serverUrl={state.data.serverUrl} />
            </div>
          </div>

          <h3 className="mt-8 text-sm font-semibold">Connected agents</h3>
          <div className="mt-3 space-y-0.5" role="list" aria-label="Connected agents">
            {state.data.connections.map((connection) => (
              <div key={connection.clientId} role="listitem">
                <ConnectedAgentRow
                  connection={connection}
                  isPending={pendingClientId === connection.clientId}
                  // One disconnect at a time, so a slower reload cannot
                  // bring back an agent a later disconnect removed.
                  isDisabled={pendingClientId !== null}
                  onDisconnect={() => void handleDisconnect(connection.clientId)}
                />
              </div>
            ))}
            {state.data.connections.length === 0 ? (
              <div className="rounded-xl bg-muted/25 px-6 py-10 text-center">
                <p className="text-sm font-medium">No agents are connected</p>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                  Agents you approve will appear here.
                </p>
              </div>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="mt-4 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
