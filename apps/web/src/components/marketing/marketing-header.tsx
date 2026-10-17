import Link from "next/link";

import { SIGN_IN_PATH } from "@/lib/app-routes";

import { InvookWordmark } from "./invook-wordmark";
import { MarketingCta } from "./marketing-cta";
import { MARKETING_SECTION_LINKS } from "./marketing-links";

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-40 bg-lp-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-6">
        <Link href="/" aria-label="Invook home" className="rounded-md">
          <InvookWordmark />
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {MARKETING_SECTION_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-full px-3.5 py-2 text-sm font-medium text-lp-ink/70 transition-colors hover:text-lp-ink"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href={SIGN_IN_PATH}
            className="hidden rounded-full px-3 py-2 text-sm font-medium text-lp-ink/70 transition-colors hover:text-lp-ink sm:block"
          >
            Log in
          </Link>
          <MarketingCta href={SIGN_IN_PATH} size="compact">
            Get started
          </MarketingCta>
        </div>
      </div>
    </header>
  );
}
