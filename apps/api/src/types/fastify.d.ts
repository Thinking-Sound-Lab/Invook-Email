import type { InvookSession } from "@invook/auth";

import type { AuthService } from "../auth/auth-service";

declare module "fastify" {
  interface FastifyInstance {
    invookAuth: AuthService;
  }

  interface FastifyRequest {
    invookSession: InvookSession | null;
    invookStartedAt: number;
  }
}

export {};
