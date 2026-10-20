import { type NextRequest, NextResponse } from "next/server";

import { getApiUrl } from "./lib/api-url";

export function proxy(request: NextRequest) {
  if (
    request.nextUrl.pathname === "/v1/mailbox/events" ||
    request.nextUrl.pathname === "/v1/account-sync/events"
  ) {
    return NextResponse.next();
  }

  const path = request.nextUrl.pathname === "/connections/gmail/callback"
    ? "/v1/connections/gmail/callback"
    : request.nextUrl.pathname;
  const target = getApiUrl(path);
  target.search = request.nextUrl.search;

  return NextResponse.rewrite(target);
}

export const config = {
  // Agents reach Invook's MCP server and its OAuth discovery documents on the
  // application origin, which owns the authorization server's issuer URL.
  matcher: [
    "/v1/:path*",
    "/connections/gmail/callback",
    "/mcp",
    "/.well-known/oauth-protected-resource/:path*",
    "/.well-known/oauth-authorization-server/:path*",
  ],
};
