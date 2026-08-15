import type { FastifyPluginAsync } from "fastify";

import type { SessionState } from "@invook/contracts";
import { hasConnectedGmailAccount } from "@invook/database";

import { createWebHeaders } from "../auth/auth-service";
import { sendJson } from "../responses";

export const registerSessionRoutes: FastifyPluginAsync = async (api) => {
  api.get("/v1/session", async (request, reply) => {
    const session = await request.server.invookAuth.getSession(
      createWebHeaders(request.headers),
    );
    if (!session) {
      const state: SessionState = {
        authenticated: false,
        gmailConnected: false,
      };
      await sendJson(reply, 200, state);
      return;
    }

    const state: SessionState = {
      authenticated: true,
      gmailConnected: await hasConnectedGmailAccount(session.userId),
    };
    await sendJson(reply, 200, state);
  });
};
