import { SIGN_IN_PATH } from "@/lib/app-routes";

import { MarketingCta } from "./marketing-cta";
import { GITHUB_REPOSITORY_URL } from "./marketing-links";

export function ClosingCtaSection() {
  return (
    <section className="marketing-reveal mx-auto max-w-7xl px-6 py-32 text-center sm:py-44">
      <h2 className="mx-auto max-w-3xl text-balance text-[2.5rem] font-semibold leading-[1.05] tracking-[-0.05em] text-lp-ink sm:text-[3.5rem]">
        Bring order to every inbox
      </h2>
      <div className="mt-9 flex flex-wrap justify-center gap-3">
        <MarketingCta href={SIGN_IN_PATH}>Get started</MarketingCta>
        <MarketingCta href={GITHUB_REPOSITORY_URL} variant="secondary">
          View on GitHub
        </MarketingCta>
      </div>
    </section>
  );
}
