/** Web page where a person signs in, including during an agent's OAuth authorization. */
export const SIGN_IN_PATH = "/sign-in";

/** Web page where a person approves or denies an agent's access to their mail. */
export const MCP_CONSENT_PATH = "/oauth/consent";

/**
 * Web page where a signed-in person sets up and disconnects agents. It does
 * not require Gmail, because an agent can be approved before Gmail is
 * connected and must stay manageable after every account is removed.
 */
export const AGENT_SETTINGS_PATH = "/settings/agents";

/** Path of Invook's MCP server on the application origin. */
export const MCP_PATH = "/mcp";

/**
 * OAuth scope that lets a connected agent read, organize, draft, and send the
 * user's mail through the MCP server.
 */
export const MCP_MAIL_SCOPE = "mail";

/** OAuth scope that lets a connected agent stay connected with refresh tokens. */
export const MCP_OFFLINE_ACCESS_SCOPE = "offline_access";

/** An agent the user authorized to use Invook through MCP. */
export type McpConnection = {
  clientId: string;
  /** The name the agent registered with, such as "Claude Code"; null when it gave none. */
  name: string | null;
  connectedAt: string;
  updatedAt: string;
};

export type McpConnectionsResponse = {
  /** The MCP server URL an agent connects to. */
  serverUrl: string;
  /** An Agent Skill (SKILL.md) that sets up and explains the Invook MCP server. */
  skill: string;
  connections: McpConnection[];
};

/** The name agents register Invook's MCP server under. */
export const MCP_SERVER_NAME = "invook";

/** Adds Invook to Claude Code for every project of the current user. */
export function buildClaudeCodeMcpCommand(serverUrl: string): string {
  return `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} ${serverUrl}`;
}

/** Adds Invook to Codex and starts its browser sign-in. */
export function buildCodexMcpCommands(serverUrl: string): [string, string] {
  return [
    `codex mcp add ${MCP_SERVER_NAME} --url ${serverUrl}`,
    `codex mcp login ${MCP_SERVER_NAME}`,
  ];
}

/** The `mcpServers` entry for Invook in Cursor's mcp.json. */
export function buildCursorMcpServerEntry(serverUrl: string): string {
  return `"${MCP_SERVER_NAME}": { "url": "${serverUrl}" }`;
}
