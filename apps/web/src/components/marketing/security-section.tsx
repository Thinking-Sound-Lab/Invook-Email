import { DatabaseIcon, LockKeyIcon, Tag01Icon, UserAccountIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { SectionHeading } from "./section-heading";

const safeguards = [
  {
    icon: LockKeyIcon,
    title: "Encrypted Gmail credentials",
    description: "Gmail access tokens are encrypted with AES-256-GCM before they are stored.",
  },
  {
    icon: UserAccountIcon,
    title: "Mailbox access is a separate step",
    description: "Signing in with Google only confirms who you are. You approve Gmail access on its own.",
  },
  {
    icon: Tag01Icon,
    title: "Labels stay in Invook",
    description: "Invook never adds its labels to Gmail. Only actions you take, like starring, change your mailbox.",
  },
  {
    icon: DatabaseIcon,
    title: "Clear about where data goes",
    description: "Mail lives in PostgreSQL, attachments in S3-compatible storage, and labeling sends OpenAI only the context it needs.",
  },
] as const;

export function SecuritySection() {
  return (
    <section id="security" className="marketing-reveal mx-auto max-w-7xl px-6 pt-28 sm:pt-36">
      <SectionHeading
        title="Careful with your mail"
        description="Invook asks for the access it needs, encrypts the credentials it keeps, and is plain about where your data lives."
      />
      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {safeguards.map((safeguard) => (
          <article key={safeguard.title} className="rounded-3xl bg-lp-surface p-7">
            <span className="grid size-10 place-items-center rounded-xl bg-lp-bg text-lp-ink">
              <HugeiconsIcon icon={safeguard.icon} size={18} strokeWidth={1.7} />
            </span>
            <h3 className="mt-10 text-lg font-semibold tracking-[-0.025em] text-lp-ink">{safeguard.title}</h3>
            <p className="mt-2 text-sm leading-6 text-lp-muted">{safeguard.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
