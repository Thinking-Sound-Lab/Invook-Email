import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGmailComposeRecipients,
  validateGmailComposeDraftFields,
} from "./gmail-compose";

test("compose recipients are parsed as an explicit comma-separated list", () => {
  assert.deepEqual(
    parseGmailComposeRecipients("first@example.com, second@example.com"),
    ["first@example.com", "second@example.com"],
  );
  assert.deepEqual(parseGmailComposeRecipients("  "), []);
});

test("compose validation rejects invalid and duplicate recipients", () => {
  const invalid = validateGmailComposeDraftFields({
    recipients: ["not-an-email"],
    subject: "Subject",
    body: "Body",
  });
  assert.deepEqual(invalid, {
    valid: false,
    error: {
      field: "recipients",
      message: "Enter valid email addresses separated by commas.",
    },
  });

  const duplicate = validateGmailComposeDraftFields({
    recipients: ["person@example.com", "PERSON@example.com"],
    subject: "Subject",
    body: "Body",
  });
  assert.equal(duplicate.valid, false);
  if (!duplicate.valid) assert.equal(duplicate.error.field, "recipients");
});

test("compose validation rejects header injection and empty bodies", () => {
  const injected = validateGmailComposeDraftFields({
    recipients: ["person@example.com"],
    subject: "Subject\r\nBcc: hidden@example.com",
    body: "Body",
  });
  assert.equal(injected.valid, false);
  if (!injected.valid) assert.equal(injected.error.field, "subject");

  const emptyBody = validateGmailComposeDraftFields({
    recipients: ["person@example.com"],
    subject: "",
    body: " \n ",
  });
  assert.equal(emptyBody.valid, false);
  if (!emptyBody.valid) assert.equal(emptyBody.error.field, "body");
});

test("compose validation preserves valid user-authored subject and body text", () => {
  const result = validateGmailComposeDraftFields({
    recipients: [" person@example.com "],
    subject: "Quarterly update",
    body: "First line\nSecond line",
  });
  assert.deepEqual(result, {
    valid: true,
    fields: {
      recipients: ["person@example.com"],
      subject: "Quarterly update",
      body: "First line\nSecond line",
    },
  });
});
