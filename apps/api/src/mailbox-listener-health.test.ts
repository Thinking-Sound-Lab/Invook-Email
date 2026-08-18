import assert from "node:assert/strict";
import test from "node:test";

import { v4 as uuidv4 } from "uuid";

import { MailboxListenerHealth } from "./mailbox-listener-health";

test("readiness requires subscription and canonical recovery", () => {
  const health = new MailboxListenerHealth();
  const userId = uuidv4();
  assert.equal(health.recordCanonicalRecovery(userId, 0), false);
  const subscription = health.subscriptionEstablished();
  assert.equal(subscription.isRecovery, false);
  assert.equal(health.isHealthyForUser(userId), false);
  assert.equal(health.recordCanonicalRecovery(userId, subscription.generation), true);
  assert.equal(health.isHealthyForUser(userId), true);
});

test("scoped degradation and recovery do not invalidate other users", () => {
  const health = new MailboxListenerHealth();
  const firstUserId = uuidv4();
  const secondUserId = uuidv4();
  const { generation } = health.subscriptionEstablished();
  health.recordCanonicalRecovery(firstUserId, generation);
  health.recordCanonicalRecovery(secondUserId, generation);
  health.invalidateUser(firstUserId);
  assert.equal(health.isHealthyForUser(firstUserId), false);
  assert.equal(health.isHealthyForUser(secondUserId), true);
  assert.equal(health.recordCanonicalRecovery(firstUserId, generation), true);
  assert.equal(health.isHealthyForUser(firstUserId), true);
});

test("re-subscribe and malformed notifications require fresh recovery", () => {
  const health = new MailboxListenerHealth();
  const userId = uuidv4();
  const initial = health.subscriptionEstablished();
  health.recordCanonicalRecovery(userId, initial.generation);
  health.subscriptionLost();
  assert.equal(health.hasSubscription, false);
  assert.equal(health.isHealthyForUser(userId), false);
  const recoveredSubscription = health.subscriptionEstablished();
  assert.equal(recoveredSubscription.isRecovery, true);
  assert.equal(health.isHealthyForUser(userId), false);
  health.recordCanonicalRecovery(userId, recoveredSubscription.generation);
  health.invalidateAll();
  assert.equal(health.isHealthyForUser(userId), false);
});
