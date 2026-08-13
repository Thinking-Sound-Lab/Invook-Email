"use client";

import { useAccountSyncEvents } from "@/hooks/use-account-sync-events";

export function AccountSyncEventSubscriber() {
  useAccountSyncEvents();
  return null;
}
