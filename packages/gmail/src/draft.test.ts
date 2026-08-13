import assert from "node:assert/strict";
import test from "node:test";

import { composePlainTextGmailMessage } from "./draft";

test("new Gmail messages contain the requested recipients, stable message ID, and CRLF body", () => {
  const raw = composePlainTextGmailMessage({
    accountEmail: "owner@example.com",
    recipients: ["first@example.com", "second@example.com"],
    subject: "Quarterly update",
    body: "First line\nSecond line",
    messageId: "invook-compose-operation@example.invalid",
  });

  assert.ok(raw);
  assert.equal(
    raw.toString("utf8"),
    [
      "From: owner@example.com",
      "To: first@example.com, second@example.com",
      "Subject: Quarterly update",
      "Message-ID: <invook-compose-operation@example.invalid>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "First line",
      "Second line",
    ].join("\r\n"),
  );
});

test("new Gmail message headers cannot be injected and unicode subjects are encoded", () => {
  const raw = composePlainTextGmailMessage({
    accountEmail: "owner@example.com\r\nBcc: hidden@example.com",
    recipients: ["person@example.com\r\nCc: hidden@example.com"],
    subject: "Résumé\r\nBcc: hidden@example.com",
    body: "Body",
    messageId: "operation@example.invalid\r\nX-Injected: true",
  });

  assert.ok(raw);
  const message = raw.toString("utf8");
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.doesNotMatch(message, /\r\nBcc:/);
  assert.doesNotMatch(message, /\r\nCc:/);
  assert.doesNotMatch(message, /\r\nX-Injected:/);
});
