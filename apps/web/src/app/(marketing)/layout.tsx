import type { Metadata } from "next";

import { jakarta } from "../fonts";
import "../globals.css";

export const metadata: Metadata = {
  title: "Invook — AI-native Gmail",
  description:
    "Invook brings your Gmail accounts into one workspace and organizes your inbox with labels you control.",
};

export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${jakarta.className} motion-safe:scroll-smooth scroll-pt-20 bg-lp-bg`}>
      <body className="bg-lp-bg text-lp-ink">{children}</body>
    </html>
  );
}
