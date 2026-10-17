import { AccountsSection } from "@/components/marketing/accounts-section";
import { CapabilitiesSection } from "@/components/marketing/capabilities-section";
import { ClosingCtaSection } from "@/components/marketing/closing-cta-section";
import { FaqSection } from "@/components/marketing/faq-section";
import { HeroSection } from "@/components/marketing/hero-section";
import { LabelsSection } from "@/components/marketing/labels-section";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { OpenSourceSection } from "@/components/marketing/open-source-section";
import { SecuritySection } from "@/components/marketing/security-section";

export default function MarketingPage() {
  return (
    <>
      <MarketingHeader />
      <main>
        <HeroSection />
        <LabelsSection />
        <AccountsSection />
        <CapabilitiesSection />
        <OpenSourceSection />
        <SecuritySection />
        <FaqSection />
        <ClosingCtaSection />
      </main>
      <MarketingFooter />
    </>
  );
}
