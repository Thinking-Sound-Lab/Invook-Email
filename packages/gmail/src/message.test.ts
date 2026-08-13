import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { parseGmailMessage } from "./message";

const attachmentBytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
const mime = Buffer.from(
  [
    "Received: from first.example by mx.example; Tue, 12 Aug 2026 09:30:00 +0000",
    "Received: from second.example by first.example; Tue, 12 Aug 2026 09:29:59 +0000",
    "From: Sender Name <sender@example.com>",
    "To: First Recipient <first@example.com>, second@example.com",
    "Cc: copy@example.com",
    "Subject: =?UTF-8?Q?Replica_=E2=9C=93?=",
    "Message-ID: <message-123@example.com>",
    "In-Reply-To: <parent@example.com>",
    "References: <root@example.com> <parent@example.com>",
    "Date: Tue, 12 Aug 2026 15:00:00 +0530",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer-boundary"',
    "",
    "--outer-boundary",
    'Content-Type: multipart/alternative; boundary="content-boundary"',
    "",
    "--content-boundary",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Complete plain text body.=0AQuoted reply remains here.",
    "--content-boundary",
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Complete <strong>HTML</strong> body.</p>",
    "--content-boundary--",
    "--outer-boundary",
    'Content-Type: application/octet-stream; name="bytes.bin"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="bytes.bin"',
    "Content-ID: <binary-content@example.com>",
    "",
    attachmentBytes.toString("base64"),
    "--outer-boundary--",
    "",
  ].join("\r\n"),
  "utf8",
);

test("raw MIME parsing preserves headers, bodies, bytes, and Gmail metadata", async () => {
  const parsed = await parseGmailMessage({
    id: "gmail-message-id",
    threadId: "gmail-thread-id",
    historyId: "4321",
    internalDate: "1786527000000",
    sizeEstimate: mime.byteLength,
    labelIds: ["INBOX", "Label_7"],
    snippet: "Complete plain text body.",
    raw: mime.toString("base64url"),
  });

  assert.equal(parsed.providerMessageId, "gmail-message-id");
  assert.equal(parsed.providerThreadId, "gmail-thread-id");
  assert.equal(parsed.historyId, "4321");
  assert.equal(parsed.internalDate, "1786527000000");
  assert.equal(parsed.sizeEstimate, mime.byteLength);
  assert.deepEqual(parsed.labelIds, ["INBOX", "Label_7"]);
  assert.deepEqual(parsed.raw, mime);
  assert.equal(parsed.rawSize, mime.byteLength);
  assert.equal(
    parsed.rawChecksumSha256,
    createHash("sha256").update(mime).digest("hex"),
  );

  assert.deepEqual(
    parsed.headers.slice(0, 2).map(({ name }) => name),
    ["received", "received"],
  );
  assert.equal(parsed.headers.filter(({ name }) => name === "received").length, 2);
  assert.equal(parsed.subject, "Replica ✓");
  assert.equal(parsed.from, '"Sender Name" <sender@example.com>');
  assert.deepEqual(parsed.to, [
    "First Recipient <first@example.com>",
    "second@example.com",
  ]);
  assert.deepEqual(parsed.cc, ["copy@example.com"]);
  assert.equal(parsed.bodyText, "Complete plain text body.\nQuoted reply remains here.");
  assert.equal(parsed.bodyHtml, "<p>Complete <strong>HTML</strong> body.</p>");
  assert.equal(parsed.sentAt, new Date(1786527000000).toISOString());

  assert.equal(parsed.attachments.length, 1);
  const [attachment] = parsed.attachments;
  assert.ok(attachment);
  assert.equal(attachment.mimePartPath, "2");
  assert.equal(attachment.filename, "bytes.bin");
  assert.equal(attachment.mimeType, "application/octet-stream");
  assert.equal(attachment.contentDisposition, "attachment");
  assert.equal(attachment.contentId, "<binary-content@example.com>");
  assert.equal(attachment.cid, "binary-content@example.com");
  assert.equal(attachment.size, attachmentBytes.byteLength);
  assert.deepEqual(attachment.content, attachmentBytes);
  assert.equal(
    attachment.checksumSha256,
    createHash("sha256").update(attachmentBytes).digest("hex"),
  );
});

test("raw MIME parsing reports absent body variants honestly", async () => {
  const plainOnly = Buffer.from(
    [
      "From: sender@example.com",
      "To: receiver@example.com",
      "Subject: Plain only",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Only the actual text body is returned.",
    ].join("\r\n"),
  );

  const parsed = await parseGmailMessage({
    id: "plain-message",
    threadId: "plain-thread",
    raw: plainOnly.toString("base64url"),
  });

  assert.equal(parsed.bodyText, "Only the actual text body is returned.");
  assert.equal(parsed.bodyHtml, null);
  assert.equal(parsed.internalDate, null);
  assert.equal(parsed.sentAt, null);
  assert.deepEqual(parsed.attachments, []);
});

test("raw MIME parsing rejects Gmail responses without MIME bytes", async () => {
  await assert.rejects(
    parseGmailMessage({
      id: "missing-raw",
      threadId: "thread",
      raw: "",
    }),
    /did not include raw MIME data/,
  );
});
