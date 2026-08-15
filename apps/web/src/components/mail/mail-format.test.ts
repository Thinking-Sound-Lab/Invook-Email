import assert from "node:assert/strict";
import test from "node:test";

import { formatMailDate } from "./mail-format";

test("mail time formatting respects the viewer timezone", () => {
  const value = "2026-08-15T20:52:00.000Z";
  const now = new Date("2026-08-15T21:00:00.000Z");

  assert.equal(
    formatMailDate(value, { now, timeZone: "Asia/Kolkata" }),
    "2:22 AM",
  );
  assert.equal(
    formatMailDate(value, { now, timeZone: "UTC" }),
    "8:52 PM",
  );
});
