"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const MINIMUM_FRAME_HEIGHT = 160;
const MAXIMUM_FRAME_HEIGHT = 12_000;

export function clampEmailFrameHeight(height: number): number {
  return Math.min(
    MAXIMUM_FRAME_HEIGHT,
    Math.max(MINIMUM_FRAME_HEIGHT, Math.ceil(height)),
  );
}

export interface EmailHtmlFrameProps {
  className?: string;
  document: string;
  frameId: string;
}

type EmailHeightMessage = {
  type: "invook-email-height";
  frameId: string;
  height: number;
};

function isEmailHeightMessage(value: unknown): value is EmailHeightMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "invook-email-height" &&
    typeof candidate.frameId === "string" &&
    typeof candidate.height === "number" &&
    Number.isFinite(candidate.height)
  );
}

export function EmailHtmlFrame({
  className,
  document,
  frameId,
}: EmailHtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MINIMUM_FRAME_HEIGHT);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        !isEmailHeightMessage(event.data) ||
        event.data.frameId !== frameId
      ) {
        return;
      }

      setHeight(clampEmailFrameHeight(event.data.height));
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameId]);

  return (
    <div className={cn("w-full", className)}>
      <iframe
        ref={frameRef}
        className="block w-full bg-white"
        height={height}
        referrerPolicy="no-referrer"
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts"
        srcDoc={document}
        title="Original email content"
      />
    </div>
  );
}
