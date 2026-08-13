import assert from "node:assert/strict";
import { test } from "node:test";

import { getReturningGmailAuthenticationAction } from "./repositories";

test("returning OAuth repairs a reconnect-required replica without a new initial run", () => {
  assert.equal(
    getReturningGmailAuthenticationAction({
      status: "reconnect_required",
      replicaState: "failed",
      historyCursor: null,
      currentHistoryId: "200",
    }),
    "repair",
  );
});

test("returning OAuth only catches up a ready connected replica when Gmail advanced", () => {
  assert.equal(
    getReturningGmailAuthenticationAction({
      status: "connected",
      replicaState: "ready",
      historyCursor: "100",
      currentHistoryId: "200",
    }),
    "catchup",
  );
  assert.equal(
    getReturningGmailAuthenticationAction({
      status: "connected",
      replicaState: "ready",
      historyCursor: "200",
      currentHistoryId: "200",
    }),
    "none",
  );
});
