import { SIGN_IN_PATH } from "@invook/contracts";
import Link from "next/link";

import { InvookWordmark } from "./invook-wordmark";
import { GITHUB_REPOSITORY_URL, MARKETING_SECTION_LINKS } from "./marketing-links";

const projectLinks = [
  { label: "GitHub", href: GITHUB_REPOSITORY_URL },
  { label: "License", href: `${GITHUB_REPOSITORY_URL}/blob/main/LICENSE` },
  { label: "Contributing", href: `${GITHUB_REPOSITORY_URL}/blob/main/.github/CONTRIBUTING.md` },
  { label: "Security policy", href: `${GITHUB_REPOSITORY_URL}/blob/main/.github/SECURITY.md` },
] as const;

const footerLinkClassName = "text-sm text-lp-muted transition-colors hover:text-lp-ink";

export function MarketingFooter() {
  return (
    <footer className="bg-lp-footer-bg">
      <div className="mx-auto max-w-7xl px-6 pb-10 pt-16">
        <div className="grid gap-12 sm:grid-cols-[minmax(0,1.5fr)_repeat(2,minmax(0,1fr))]">
          <div>
            <InvookWordmark />
            <p className="mt-3 max-w-xs text-sm leading-6 text-lp-muted">
              An open-source, AI-native alternative for Gmail.
            </p>
          </div>
          <nav aria-label="Product">
            <p className="text-sm font-semibold text-lp-ink">Product</p>
            <ul className="mt-4 space-y-3">
              {MARKETING_SECTION_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className={footerLinkClassName}>
                    {link.label}
                  </a>
                </li>
              ))}
              <li>
                <Link href={SIGN_IN_PATH} className={footerLinkClassName}>
                  Log in
                </Link>
              </li>
            </ul>
          </nav>
          <nav aria-label="Project">
            <p className="text-sm font-semibold text-lp-ink">Project</p>
            <ul className="mt-4 space-y-3">
              {projectLinks.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className={footerLinkClassName}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <p className="mt-16 text-sm text-lp-muted">© 2026 Thinking Sound Lab · Apache License 2.0</p>
      </div>
    </footer>
  );
}
