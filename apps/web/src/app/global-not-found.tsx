import type { Metadata } from "next";
import Link from "next/link";

import { jakarta } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Page not found — Invook",
};

export default function GlobalNotFound() {
  return (
    <html lang="en" className={`${jakarta.className} bg-lp-bg`}>
      <body className="bg-lp-bg text-lp-ink">
        <main className="grid min-h-dvh place-items-center px-6">
          <div className="flex max-w-sm flex-col items-center gap-5 text-center">
            <h1 className="text-3xl font-semibold tracking-[-0.04em]">Page not found</h1>
            <p className="text-base leading-7 text-lp-muted">
              This address doesn’t match any page on Invook.
            </p>
            <Link
              href="/"
              className="inline-flex h-11 items-center rounded-full bg-lp-ink px-5 text-[15px] font-semibold text-inverse transition-colors hover:bg-landing-cta-bg"
            >
              Go to the home page
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
