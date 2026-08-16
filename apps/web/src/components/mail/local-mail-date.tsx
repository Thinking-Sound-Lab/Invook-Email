"use client";

import { useSyncExternalStore } from "react";

import { formatMailDate } from "./mail-format";

const subscribeToBrowserTime = (): (() => void) => () => undefined;

interface LocalMailDateProps {
  className?: string;
  value: string | null;
}

export function LocalMailDate({ className, value }: LocalMailDateProps) {
  const formattedDate = useSyncExternalStore(
    subscribeToBrowserTime,
    () => formatMailDate(value),
    () => "",
  );

  return (
    <time className={className} dateTime={value ?? undefined}>
      {formattedDate}
    </time>
  );
}
