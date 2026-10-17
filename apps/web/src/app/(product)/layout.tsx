import type { Metadata } from "next";

import { TooltipProvider } from "@/components/ui/tooltip";

import { jakarta } from "../fonts";
import "../globals.css";

export const metadata: Metadata = {
  title: "Invook — AI-native Gmail",
  description: "Connect Gmail and let Invook label your mail automatically.",
};

export default function ProductLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${jakarta.className}`}>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
