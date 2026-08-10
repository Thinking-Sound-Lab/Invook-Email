import type { FastifyPluginAsync } from "fastify";

import {
  createUserLabel,
  deleteUserLabel,
  LabelConflictError,
} from "@invook/database";

import { mutationAccessHooks, requireUuidParameter } from "../access";
import { sendJson, sendProblem } from "../responses";

type LabelParams = {
  labelId: string;
};

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export const registerLabelRoutes: FastifyPluginAsync = async (api) => {
  api.post<{ Body: unknown }>(
    "/",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const body = request.body;
      const name =
        body && typeof body === "object" && "name" in body ? body.name : null;
      const description =
        body && typeof body === "object" && "description" in body
          ? body.description
          : null;
      if (
        typeof name !== "string" ||
        !normalize(name) ||
        typeof description !== "string" ||
        !normalize(description)
      ) {
        await sendProblem(
          request,
          reply,
          400,
          "Label name and description are required",
        );
        return;
      }

      try {
        const label = await createUserLabel({
          userId: session.userId,
          name: normalize(name),
          description: normalize(description),
        });
        if (!label) {
          await sendProblem(
            request,
            reply,
            404,
            "Connected Gmail account not found",
          );
          return;
        }
        await sendJson(reply, 201, { label });
      } catch (error) {
        if (error instanceof LabelConflictError) {
          await sendProblem(request, reply, 409, error.message);
          return;
        }
        throw error;
      }
    },
  );

  api.delete<{ Params: LabelParams }>(
    "/:labelId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("labelId", "Label ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const deleted = await deleteUserLabel({
        userId: session.userId,
        labelId: request.params.labelId,
      });
      if (!deleted) {
        await sendProblem(request, reply, 404, "Label not found");
        return;
      }
      await sendJson(reply, 200, { deleted: true });
    },
  );
};
