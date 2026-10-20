import { MCP_SERVER_NAME } from "@invook/contracts";

/**
 * Cursor's MCP install link: the server's mcp.json entry, base64-encoded.
 * Opening it asks Cursor to add Invook, which then prompts for sign-in.
 */
export function buildCursorInstallLink(serverUrl: string): string {
  const query = new URLSearchParams({
    name: MCP_SERVER_NAME,
    config: btoa(JSON.stringify({ url: serverUrl })),
  });
  return `cursor://anysphere.cursor-deeplink/mcp/install?${query.toString()}`;
}
