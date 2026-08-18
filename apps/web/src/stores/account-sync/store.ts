import type { AccountSyncStatusEvent } from "@invook/contracts";
import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface AccountSyncStoreState {
  connectionStatus: "connecting" | "available" | "unavailable";
  progress: AccountSyncStatusEvent | null;
  setConnectionStatus: (connectionStatus: AccountSyncStoreState["connectionStatus"]) => void;
  setProgress: (progress: AccountSyncStatusEvent) => void;
  reset: () => void;
}

const initialState: Pick<AccountSyncStoreState, "connectionStatus" | "progress"> = {
  connectionStatus: "connecting",
  progress: null,
};

export const useAccountSyncStore = create<AccountSyncStoreState>()(
  devtools(
    (set) => ({
      ...initialState,
      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
      setProgress: (progress) => set({ progress }),
      reset: () => set(initialState),
    }),
    { name: "account-sync-store" },
  ),
);
