export function extractEmail(value: string): string {
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

export function initials(value: string): string {
  return value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function formatMailDate(value: string | null): string {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return new Intl.DateTimeFormat("en", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
    }).format(date);
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatMessageDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
