type HeaderLine = { key: string; line: string };

function safeHeaderValue(value: string): string {
  return value
    .replace(/\r?\n[\t ]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

function headerValue(headers: HeaderLine[], name: string): string | null {
  const header = headers.find((candidate) => candidate.key.toLowerCase() === name);
  if (!header) return null;
  const separator = header.line.indexOf(":");
  const value = separator >= 0 ? header.line.slice(separator + 1) : header.line;
  return safeHeaderValue(value) || null;
}

function replySubject(subject: string): string {
  const value = safeHeaderValue(subject);
  return /^re\s*:/i.test(value) ? value : `Re: ${value}`;
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

function subjectHeaderValue(value: string): string {
  const subject = safeHeaderValue(value);
  return /^[\u0020-\u007e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

export function composePlainTextGmailMessage(input: {
  accountEmail: string;
  recipients: string[];
  subject: string;
  body: string;
  messageId: string;
}): Buffer | null {
  const sender = safeHeaderValue(input.accountEmail);
  const recipients = input.recipients
    .map((recipient) => safeHeaderValue(recipient))
    .filter(Boolean);
  const rawMessageId = safeHeaderValue(input.messageId).replace(/^<|>$/g, "");
  if (!sender || recipients.length === 0 || !rawMessageId) return null;

  const headers = [
    `From: ${sender}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${subjectHeaderValue(input.subject)}`,
    `Message-ID: <${rawMessageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${normalizeBody(input.body)}`,
    "utf8",
  );
}

export function composePlainTextGmailReply(input: {
  accountEmail: string;
  subject: string;
  currentText: string;
  replyTarget: {
    sender: { raw: string; email: string };
    headerLines: HeaderLine[];
  };
}): Buffer | null {
  const replyTo = headerValue(input.replyTarget.headerLines, "reply-to");
  const recipient = safeHeaderValue(
    replyTo || input.replyTarget.sender.raw || input.replyTarget.sender.email,
  );
  const sender = safeHeaderValue(input.accountEmail);
  if (!recipient || !sender) return null;

  const messageId = headerValue(input.replyTarget.headerLines, "message-id");
  const previousReferences = headerValue(
    input.replyTarget.headerLines,
    "references",
  );
  const references = previousReferences
    ? messageId && !previousReferences.includes(messageId)
      ? `${previousReferences} ${messageId}`
      : previousReferences
    : messageId;
  const headers = [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${replySubject(input.subject)}`,
    ...(messageId ? [`In-Reply-To: ${messageId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${normalizeBody(input.currentText)}`,
    "utf8",
  );
}
