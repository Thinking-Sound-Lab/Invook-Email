import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ctaVariantClassNames = {
  primary: "bg-lp-ink text-inverse hover:bg-landing-cta-bg",
  secondary: "bg-lp-footer-bg text-lp-ink hover:bg-landing-cta-border",
} as const;

const ctaSizeClassNames = {
  default: "h-11 px-5 text-[15px]",
  compact: "h-9 px-4 text-sm",
} as const;

export interface MarketingCtaProps {
  href: string;
  children: ReactNode;
  variant?: keyof typeof ctaVariantClassNames;
  size?: keyof typeof ctaSizeClassNames;
  className?: string;
}

export function MarketingCta({
  href,
  children,
  variant = "primary",
  size = "default",
  className,
}: MarketingCtaProps) {
  const isExternal = /^https?:\/\//.test(href);

  return (
    <Button
      asChild
      className={cn(
        "rounded-full font-semibold tracking-[-0.01em]",
        ctaSizeClassNames[size],
        ctaVariantClassNames[variant],
        className,
      )}
    >
      {isExternal ? <a href={href}>{children}</a> : <Link href={href}>{children}</Link>}
    </Button>
  );
}
