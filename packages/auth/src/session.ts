import type { InvookAuth } from "./auth";

export interface InvookSession {
  userId: string;
  /** The stored Better Auth session, so long-lived connections can re-check it. */
  sessionId: string;
  user: {
    email: string;
    image: string | null;
    name: string;
  };
  expiresAt: Date;
}

export interface InvookSessionResolution {
  session: InvookSession | null;
  /**
   * Cookies Better Auth issued while resolving the session: a renewed cookie
   * cache, an extended session, or the removal of a dead one. They take effect
   * only when the caller sends them to the browser.
   */
  setCookies: string[];
}

export async function getInvookSession(
  auth: InvookAuth,
  headers: Headers,
): Promise<InvookSessionResolution> {
  const { headers: responseHeaders, response: result } =
    await auth.api.getSession({ headers, returnHeaders: true });
  const setCookies = responseHeaders.getSetCookie();
  if (!result) return { session: null, setCookies };
  const name: unknown = result.user.name;

  return {
    session: {
      userId: result.user.id,
      sessionId: result.session.id,
      user: {
        email: result.user.email,
        image: result.user.image ?? null,
        name:
          typeof name === "string" && name.trim().length > 0
            ? name
            : result.user.email,
      },
      expiresAt: result.session.expiresAt,
    },
    setCookies,
  };
}
