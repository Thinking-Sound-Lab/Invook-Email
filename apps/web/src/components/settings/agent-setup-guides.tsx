"use client";

import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  buildClaudeCodeMcpCommand,
  buildCodexMcpCommands,
  buildCursorMcpServerEntry,
  MCP_SERVER_NAME,
} from "@invook/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { buildCursorInstallLink } from "./agent-setup-links";
import { CopyValueButton } from "./copy-value-button";

export interface AgentSetupGuidesProps {
  serverUrl: string;
}

interface CommandRowProps {
  value: string;
  label: string;
}

const agentGuides = [
  { value: "claude-code", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "codex", label: "Codex" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude", label: "Claude app" },
] as const;

type AgentGuide = (typeof agentGuides)[number]["value"];

function CommandRow({ value, label }: CommandRowProps) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-background/55 px-3 py-2.5">
      <code className="min-w-0 flex-1 break-all font-sans text-xs leading-5 text-foreground">
        {value}
      </code>
      <CopyValueButton value={value} label={label} />
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="list-decimal space-y-3 pl-4 text-sm leading-6 text-muted-foreground marker:text-foreground/50">
      {children}
    </ol>
  );
}

export function AgentSetupGuides({ serverUrl }: AgentSetupGuidesProps) {
  const [guide, setGuide] = useState<AgentGuide>("claude-code");
  const [codexAddCommand, codexLoginCommand] = buildCodexMcpCommands(serverUrl);

  return (
    <div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Agent setup guides">
        {agentGuides.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={option.value === guide ? "secondary" : "ghost"}
            size="sm"
            className="text-xs"
            aria-pressed={option.value === guide}
            onClick={() => setGuide(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <div className="mt-4">
        {guide === "claude-code" ? (
          <Steps>
            <li>
              Run this in a terminal:
              <div className="mt-2">
                <CommandRow value={buildClaudeCodeMcpCommand(serverUrl)} label="Copy" />
              </div>
            </li>
            <li>
              In Claude Code, run /mcp, select {MCP_SERVER_NAME}, and sign in to
              Invook in your browser.
            </li>
          </Steps>
        ) : null}
        {guide === "cursor" ? (
          <Steps>
            <li>
              Add Invook to Cursor:
              <div className="mt-2">
                <Button asChild variant="secondary" size="sm" className="text-xs">
                  <a href={buildCursorInstallLink(serverUrl)}>
                    Add to Cursor
                    <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} />
                  </a>
                </Button>
              </div>
              <p className="mt-2">
                Or add this entry to mcpServers in ~/.cursor/mcp.json:
              </p>
              <div className="mt-2">
                <CommandRow value={buildCursorMcpServerEntry(serverUrl)} label="Copy" />
              </div>
            </li>
            <li>
              In Cursor&apos;s MCP settings, sign in to {MCP_SERVER_NAME} when Cursor
              asks.
            </li>
          </Steps>
        ) : null}
        {guide === "codex" ? (
          <Steps>
            <li>
              Add Invook to Codex:
              <div className="mt-2">
                <CommandRow value={codexAddCommand} label="Copy" />
              </div>
            </li>
            <li>
              Sign in to Invook in your browser:
              <div className="mt-2">
                <CommandRow value={codexLoginCommand} label="Copy" />
              </div>
            </li>
          </Steps>
        ) : null}
        {guide === "chatgpt" ? (
          <Steps>
            <li>
              Open ChatGPT on the web and turn on developer mode for apps and
              connectors in Settings. Developer mode is available on paid plans, and
              workspace admins may need to allow it.
            </li>
            <li>
              Create a connector named Invook with the server URL above and OAuth
              authentication. Leave the client ID and secret empty.
            </li>
            <li>Sign in to Invook when ChatGPT asks, then enable Invook in a chat.</li>
          </Steps>
        ) : null}
        {guide === "claude" ? (
          <Steps>
            <li>
              In Claude on the web or desktop, open Settings, then Connectors, and
              add a custom connector.
            </li>
            <li>Name it Invook and paste the server URL above.</li>
            <li>Choose Connect and sign in to Invook in your browser.</li>
          </Steps>
        ) : null}
      </div>
    </div>
  );
}
