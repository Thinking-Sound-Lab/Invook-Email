import { type NextRequest, NextResponse } from "next/server";

function getApiOrigin(): string {
  return (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

export function proxy(request: NextRequest) {
  if (
    request.nextUrl.pathname === "/v1/mailbox/events" ||
    request.nextUrl.pathname === "/v1/indexing/events"
  ) {
    return NextResponse.next();
  }

  const target = new URL(request.nextUrl.pathname, getApiOrigin());
  target.search = request.nextUrl.search;

  if (request.nextUrl.pathname === "/auth/callback") {
    target.pathname = "/v1/auth/google/callback";
  }

  return NextResponse.rewrite(target);
}

export const config = {
  matcher: ["/v1/:path*", "/auth/callback"],
};
