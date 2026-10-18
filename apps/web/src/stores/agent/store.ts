import { create } from "zustand";
import { devtools } from "zustand/middleware";

/**
 * Whether the agent pane is open. The sidebar toggle and the pane live in
 * separate parts of the mail layout, so the state is shared here.
 */
interface AgentPaneState {
  isPaneOpen: boolean;
  setPaneOpen: (isPaneOpen: boolean) => void;
  togglePane: () => void;
  reset: () => void;
}

const initialState: Pick<AgentPaneState, "isPaneOpen"> = {
  isPaneOpen: false,
};

export const useAgentPaneStore = create<AgentPaneState>()(
  devtools(
    (set) => ({
      ...initialState,
      setPaneOpen: (isPaneOpen) => set({ isPaneOpen }),
      togglePane: () => set((state) => ({ isPaneOpen: !state.isPaneOpen })),
      reset: () => set(initialState),
    }),
    { name: "agent-pane-store" },
  ),
);
