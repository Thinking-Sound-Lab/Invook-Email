"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export interface EmailHtmlContentProps {
  className?: string;
  sanitizedHtml: string;
}

export function EmailHtmlContent({
  className,
  sanitizedHtml,
}: EmailHtmlContentProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = sanitizedHtml;

    return () => shadowRoot.replaceChildren();
  }, [sanitizedHtml]);

  return (
    <div
      ref={hostRef}
      className={cn("block min-w-0 w-full", className)}
      aria-label="Original email content"
    />
  );
}
