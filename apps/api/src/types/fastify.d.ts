import type { InvookSession } from "../auth/session";

declare module "fastify" {
  interface FastifyRequest {
    invookSession: InvookSession | null;
  }
}

export {};
