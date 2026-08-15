import type { InvookAuth } from "./auth";

export interface InvookSession {
  userId: string;
  user: {
    email: string;
    image: string | null;
    name: string;
  };
  expiresAt: Date;
}

export async function getInvookSession(
  auth: InvookAuth,
  headers: Headers,
): Promise<InvookSession | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  const name: unknown = result.user.name;

  return {
    userId: result.user.id,
    user: {
      email: result.user.email,
      image: result.user.image ?? null,
      name:
        typeof name === "string" && name.trim().length > 0
          ? name
          : result.user.email,
    },
    expiresAt: result.session.expiresAt,
  };
}
