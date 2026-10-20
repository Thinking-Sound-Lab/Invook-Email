import { SIGN_IN_PATH } from "@invook/contracts";

import { MarketingCta } from "./marketing-cta";
import { GITHUB_REPOSITORY_URL } from "./marketing-links";
import { ProductPreview } from "./product-preview";

export function HeroSection() {
  return (
    <section className="mx-auto max-w-7xl px-6 pt-16 sm:pt-24">
      <h1 className="max-w-4xl text-balance text-[2.75rem] font-semibold leading-[1.04] tracking-[-0.05em] text-lp-ink sm:text-[4rem]">
        Gmail, organized on your terms
      </h1>
      <p className="mt-5 max-w-xl text-pretty text-lg leading-8 text-lp-muted">
        Invook brings your Gmail accounts into one workspace and labels every new Inbox thread
        with categories you describe in plain language.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <MarketingCta href={SIGN_IN_PATH}>Get started</MarketingCta>
        <MarketingCta href={GITHUB_REPOSITORY_URL} variant="secondary">
          View on GitHub
        </MarketingCta>
      </div>
      <ProductPreview className="mt-14 sm:mt-16" />
    </section>
  );
}
