import type { InvookSession } from "@invook/auth";

import type { AuthService } from "../auth/auth-service";

declare module "fastify" {
  interface FastifyInstance {
    invookAuth: AuthService;
  }

  interface FastifyRequest {
    invookSession: InvookSession | null;
    /** The identity a redeemed ticket granted to an agent socket upgrade. */
    invookAgentSocket: { userId: string; sessionId: string } | null;
    invookStartedAt: number;
  }
}

export {};
