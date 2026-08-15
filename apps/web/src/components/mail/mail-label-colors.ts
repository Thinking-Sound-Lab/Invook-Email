import type { MailRowLabel } from "./mail-row-labels";

const MAIL_LABEL_COLOR_CLASSES = [
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
] as const;

export function mailLabelColorClassName(
  label: Pick<MailRowLabel, "id" | "kind">,
): string {
  const identity = `${label.kind}:${label.id}`;
  let hash = 2_166_136_261;

  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return MAIL_LABEL_COLOR_CLASSES[(hash >>> 0) % MAIL_LABEL_COLOR_CLASSES.length];
}
