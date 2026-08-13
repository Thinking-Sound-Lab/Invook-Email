"use client";

import { useEffect, useRef, useState } from "react";

const MINIMUM_FRAME_HEIGHT = 160;
const MAXIMUM_FRAME_HEIGHT = 2_400;

export interface EmailHtmlFrameProps {
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

export function EmailHtmlFrame({ document, frameId }: EmailHtmlFrameProps) {
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

      setHeight(
        Math.min(
          MAXIMUM_FRAME_HEIGHT,
          Math.max(MINIMUM_FRAME_HEIGHT, Math.ceil(event.data.height)),
        ),
      );
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameId]);

  return (
    <iframe
      ref={frameRef}
      className="block w-full rounded-lg bg-white"
      height={height}
      referrerPolicy="no-referrer"
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts"
      srcDoc={document}
      title="Original email content"
    />
  );
}
