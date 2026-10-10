import assert from "node:assert/strict";
import test from "node:test";

import {
  gmailHistoryCatchupDisposition,
  gmailHistoryReplayStart,
  planGmailHistoryCatchup,
  planGmailSyncFinalizeReplay,
} from "./history-catchup";

test("ready replicas continue incrementally from the committed cursor", () => {
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "ready",
      initialHistoryId: "100",
      historyCursor: "140",
    }),
    {
      kind: "apply",
      expectedCursor: "140",
      startHistoryId: "140",
      stateAfterApply: "ready",
      ingestionMode: "incremental",
      shouldRepairExpiredCursor: true,
    },
  );
});

test("repairing replicas apply live changes from the repair baseline", () => {
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "repairing",
      initialHistoryId: "100",
      historyCursor: null,
      repairStartingHistoryCursor: "200",
    }),
    {
      kind: "apply",
      expectedCursor: "100",
      startHistoryId: "200",
      stateAfterApply: "repairing",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    },
  );
});

test("repair catch-up advances from its committed live cursor", () => {
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "repairing",
      initialHistoryId: "100",
      historyCursor: "240",
      repairStartingHistoryCursor: "200",
    }),
    {
      kind: "apply",
      expectedCursor: "240",
      startHistoryId: "240",
      stateAfterApply: "repairing",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    },
  );
});

test("snapshotting replicas apply live changes without becoming ready", () => {
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "snapshotting",
      initialHistoryId: "100",
      historyCursor: null,
    }),
    {
      kind: "apply",
      expectedCursor: "100",
      startHistoryId: "100",
      stateAfterApply: "snapshotting",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    },
  );
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "snapshotting",
      initialHistoryId: "100",
      historyCursor: "150",
    }),
    {
      kind: "apply",
      expectedCursor: "150",
      startHistoryId: "150",
      stateAfterApply: "snapshotting",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    },
  );
});

test("replicas without a usable live baseline remain deferred", () => {
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "repairing",
      initialHistoryId: "100",
      historyCursor: null,
    }),
    { kind: "defer", state: "repairing" },
  );
});

test("finalize replay starts from the committed live cursor after catch-up", () => {
  assert.deepEqual(
    planGmailSyncFinalizeReplay({
      historyCursor: "5000",
      initialHistoryId: "100",
      startingHistoryCursor: "100",
    }),
    { expectedCursor: "5000", startHistoryId: "5000" },
  );
  assert.deepEqual(
    planGmailSyncFinalizeReplay({
      historyCursor: "240",
      initialHistoryId: "100",
      startingHistoryCursor: "200",
    }),
    { expectedCursor: "240", startHistoryId: "240" },
  );
  assert.deepEqual(
    planGmailSyncFinalizeReplay({
      historyCursor: null,
      initialHistoryId: "100",
      startingHistoryCursor: "100",
    }),
    { expectedCursor: "100", startHistoryId: "100" },
  );
});

test("finalize replay keeps the repair baseline when live catch-up has not advanced", () => {
  assert.deepEqual(
    planGmailSyncFinalizeReplay({
      historyCursor: null,
      initialHistoryId: "100",
      startingHistoryCursor: "200",
    }),
    { expectedCursor: "100", startHistoryId: "200" },
  );
});

test("history replay prefers the later of the committed cursor and the baseline", () => {
  assert.equal(
    gmailHistoryReplayStart({
      expectedCursor: "240",
      baselineHistoryId: "200",
    }),
    "240",
  );
  assert.equal(
    gmailHistoryReplayStart({
      expectedCursor: "100",
      baselineHistoryId: "200",
    }),
    "200",
  );
});

test("a pending cursor yields to a durable continuation after one range", () => {
  assert.equal(
    gmailHistoryCatchupDisposition({
      applied: true,
      pendingHistoryCursor: "150",
    }),
    "continue_durably",
  );
});

test("a caught-up range completes and a stale range is superseded", () => {
  assert.equal(
    gmailHistoryCatchupDisposition({
      applied: true,
      pendingHistoryCursor: null,
    }),
    "complete",
  );
  assert.equal(
    gmailHistoryCatchupDisposition({
      applied: false,
      pendingHistoryCursor: "150",
    }),
    "superseded",
  );
});
