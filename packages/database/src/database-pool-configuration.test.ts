import assert from "node:assert/strict";
import { test } from "node:test";

import { getDatabasePoolConfiguration } from "./database-pool-configuration";

test("default application pools leave space for listeners within a 15-session budget", () => {
  const configuration = getDatabasePoolConfiguration({});
  assert.deepEqual(configuration, { queryPoolSize: 3, controlPoolSize: 2 });
  const apiListeners = 2;
  const workerListeners = 1;
  assert.equal(2 * (configuration.queryPoolSize + configuration.controlPoolSize) + apiListeners + workerListeners, 13);
});

test("query and advisory-lock pool capacities can be configured independently", () => {
  assert.deepEqual(getDatabasePoolConfiguration({ DATABASE_POOL_SIZE: "8", DATABASE_CONTROL_POOL_SIZE: "4" }), {
    queryPoolSize: 8, controlPoolSize: 4,
  });
});

test("invalid pool settings fail without including their values", () => {
  for (const value of ["", "0", "-1", "1.5", "1e3", "9007199254740992", "private-input"]) {
    for (const name of ["DATABASE_POOL_SIZE", "DATABASE_CONTROL_POOL_SIZE"]) {
      assert.throws(() => getDatabasePoolConfiguration({ [name]: value }), (error: unknown) =>
        error instanceof Error && error.message === name + " must be a positive integer.");
    }
  }
});
