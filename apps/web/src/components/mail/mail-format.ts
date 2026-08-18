function extractEmail(value: string): string {
  const angleAddress = value.match(/<([^>]+)>/);
  return (angleAddress?.[1] ?? value).trim().toLowerCase();
}

export function displayName(value: string): string {
  const namedAddress = value.match(/^\s*"?([^"<]+?)"?\s*</);
  if (namedAddress?.[1]) return namedAddress[1].trim();

  const email = extractEmail(value);
  return email.split("@")[0] || email;
}

export function threadPeople(participants: string[], accountEmail: string): string {
  const ownerEmail = accountEmail.toLowerCase();
  const people = participants
    .filter((participant) => extractEmail(participant) !== ownerEmail)
    .map(displayName)
    .filter((name, index, values) => values.indexOf(name) === index);

  if (people.length === 0) return "You";
  if (people.length <= 2) return people.join(", ");
  return `${people.slice(0, 2).join(", ")} +${people.length - 2}`;
}

function formatRecipient(value: string, accountEmail: string): string {
  const email = extractEmail(value);
  if (!email) return formatMailText(value);
  if (email === accountEmail.toLowerCase()) return `me (${email})`;

  const name = displayName(value);
  const hasNamedAddress = value.includes("<") && value.includes(">");
  return hasNamedAddress && name && name.toLowerCase() !== email
    ? `${name} (${email})`
    : email;
}

export function formatRecipientSummary(
  recipients: string[],
  accountEmail: string,
): string {
  const formattedRecipients = recipients
    .map((recipient) => formatRecipient(recipient, accountEmail))
    .filter(Boolean);
  if (formattedRecipients.length === 0) return "Recipients unavailable";
  if (formattedRecipients.length <= 2) return formattedRecipients.join(", ");
  return `${formattedRecipients.slice(0, 2).join(", ")} +${formattedRecipients.length - 2}`;
}

export function formatRecipientDetails(
  recipients: string[],
  accountEmail: string,
): string {
  const formattedRecipients = recipients
    .map((recipient) => formatRecipient(recipient, accountEmail))
    .filter(Boolean);
  return formattedRecipients.join(", ") || "Recipients unavailable";
}

export function initials(value: string): string {
  return value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function decodeCharacterReference(reference: string, value: string): string {
  if (reference === "amp") return "&";
  if (reference === "lt") return "<";
  if (reference === "gt") return ">";
  if (reference === "quot") return '"';
  if (reference === "apos" || reference === "#39") return "'";
  if (reference === "nbsp") return " ";

  const numeric = reference.startsWith("#x")
    ? Number.parseInt(reference.slice(2), 16)
    : reference.startsWith("#")
      ? Number.parseInt(reference.slice(1), 10)
      : Number.NaN;

  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
    ? String.fromCodePoint(numeric)
    : value;
}

function decodeMailEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (match, reference: string) => decodeCharacterReference(reference.toLowerCase(), match),
    );
    if (next === decoded) break;
    decoded = next;
  }

  return decoded.replace(/[\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}

export function formatMailText(value: string): string {
  return decodeMailEntities(value).replace(/\s+/g, " ").trim();
}

export function formatMailBody(value: string): string {
  return decodeMailEntities(value)
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface FormatMailDateOptions {
  now?: Date;
  timeZone?: string;
}

export function formatMailDate(
  value: string | null,
  options: FormatMailDateOptions = {},
): string {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = options.now ?? new Date();
  const timeZoneOptions = options.timeZone
    ? { timeZone: options.timeZone }
    : {};
  const calendarDateFormatter = new Intl.DateTimeFormat("en", {
    ...timeZoneOptions,
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
  const yearFormatter = new Intl.DateTimeFormat("en", {
    ...timeZoneOptions,
    year: "numeric",
  });
  const sameDay =
    calendarDateFormatter.format(date) === calendarDateFormatter.format(now);

  if (sameDay) {
    return new Intl.DateTimeFormat("en", {
      ...timeZoneOptions,
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  if (yearFormatter.format(date) === yearFormatter.format(now)) {
    return new Intl.DateTimeFormat("en", {
      ...timeZoneOptions,
      month: "short",
      day: "numeric",
    }).format(date);
  }

  return new Intl.DateTimeFormat("en", {
    ...timeZoneOptions,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
