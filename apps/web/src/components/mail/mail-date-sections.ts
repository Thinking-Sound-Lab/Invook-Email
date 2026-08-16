import type { MailThreadSummary } from "./types";

export type MailDateSectionId =
  | "today"
  | "yesterday"
  | "last-seven-days"
  | "older";

export interface MailDateSection {
  id: MailDateSectionId;
  label: string | null;
  threads: MailThreadSummary[];
}

const sectionLabels: Record<MailDateSectionId, string | null> = {
  today: null,
  yesterday: "Yesterday",
  "last-seven-days": "Last 7 days",
  older: "Older",
};

function startOfLocalDay(value: Date, dayOffset = 0): number {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate() + dayOffset,
  ).getTime();
}

function threadTimestamp(thread: MailThreadSummary): number | null {
  if (!thread.latestMessageAt) return null;

  const timestamp = new Date(thread.latestMessageAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getMailDateSectionId(
  thread: MailThreadSummary,
  boundaries: {
    today: number;
    yesterday: number;
    lastSevenDays: number;
  },
): MailDateSectionId {
  const timestamp = threadTimestamp(thread);
  if (timestamp === null) return "older";
  if (timestamp >= boundaries.today) return "today";
  if (timestamp >= boundaries.yesterday) return "yesterday";
  if (timestamp >= boundaries.lastSevenDays) return "last-seven-days";
  return "older";
}

export function createMailDateSections(
  threads: MailThreadSummary[],
  now = new Date(),
): MailDateSection[] {
  const boundaries = {
    today: startOfLocalDay(now),
    yesterday: startOfLocalDay(now, -1),
    lastSevenDays: startOfLocalDay(now, -7),
  };
  const threadsBySection: Record<MailDateSectionId, MailThreadSummary[]> = {
    today: [],
    yesterday: [],
    "last-seven-days": [],
    older: [],
  };
  const sortedThreads = [...threads].sort(
    (left, right) =>
      (threadTimestamp(right) ?? Number.NEGATIVE_INFINITY) -
      (threadTimestamp(left) ?? Number.NEGATIVE_INFINITY),
  );

  for (const thread of sortedThreads) {
    threadsBySection[getMailDateSectionId(thread, boundaries)].push(thread);
  }

  return (Object.keys(threadsBySection) as MailDateSectionId[]).flatMap(
    (id) =>
      threadsBySection[id].length > 0
        ? [{ id, label: sectionLabels[id], threads: threadsBySection[id] }]
        : [],
  );
}
