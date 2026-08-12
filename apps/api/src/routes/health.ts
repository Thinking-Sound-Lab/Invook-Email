import type { FastifyPluginAsync } from "fastify";

import { checkDatabaseConnection } from "@invook/database";

import { getMissingApiConfiguration } from "../config";
import { sendJson, sendProblem } from "../responses";

export const registerHealthRoutes: FastifyPluginAsync = async (api) => {
  api.get("/health/live", async (_request, reply) => {
    await sendJson(reply, 200, { status: "ok" });
  });

  api.get("/health/ready", async (request, reply) => {
    if (getMissingApiConfiguration().length > 0) {
      await sendProblem(request, reply, 503, "API configuration is incomplete");
      return;
    }
    await checkDatabaseConnection();
    await sendJson(reply, 200, { status: "ready" });
  });
};
