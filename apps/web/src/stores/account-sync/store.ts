import type { AccountSyncStatusEvent } from "@invook/contracts";
import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface AccountSyncStoreState {
  progress: AccountSyncStatusEvent | null;
  setProgress: (progress: AccountSyncStatusEvent) => void;
  reset: () => void;
}

const initialState: Pick<AccountSyncStoreState, "progress"> = {
  progress: null,
};

export const useAccountSyncStore = create<AccountSyncStoreState>()(
  devtools(
    (set) => ({
      ...initialState,
      setProgress: (progress) => set({ progress }),
      reset: () => set(initialState),
    }),
    { name: "account-sync-store" },
  ),
);
