"use client";

import type { MailboxShell } from "@invook/contracts";
import { createContext, useContext, useEffect, type ReactNode } from "react";

import { useMailboxStore } from "@/stores/mailbox/store";

const MailShellContext = createContext<MailboxShell | null>(null);

interface MailShellProviderProps {
  children: ReactNode;
  shell: MailboxShell;
}

export function MailShellProvider({ children, shell }: MailShellProviderProps) {
  const setShell = useMailboxStore((state) => state.setShell);
  const reset = useMailboxStore((state) => state.reset);
  useEffect(() => setShell(shell), [setShell, shell]);
  useEffect(() => () => reset(), [reset]);

  return (
    <MailShellContext.Provider value={shell}>
      {children}
    </MailShellContext.Provider>
  );
}

export function useMailShell(): MailboxShell {
  const shell = useContext(MailShellContext);
  const cachedShell = useMailboxStore((state) => state.shell);
  if (!shell) throw new Error("MailShellProvider is required.");
  return cachedShell ?? shell;
}
