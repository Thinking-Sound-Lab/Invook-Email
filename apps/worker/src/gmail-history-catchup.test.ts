import assert from "node:assert/strict";
import test from "node:test";

import {
  gmailHistoryCatchupDisposition,
  planGmailHistoryCatchup,
} from "./gmail-history-catchup";

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

test("non-ready replicas without an active repair remain deferred", () => {
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "snapshotting",
      initialHistoryId: "100",
      historyCursor: null,
    }),
    { kind: "defer", state: "snapshotting" },
  );
  assert.deepEqual(
    planGmailHistoryCatchup({
      replicaState: "repairing",
      initialHistoryId: "100",
      historyCursor: null,
    }),
    { kind: "defer", state: "repairing" },
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
