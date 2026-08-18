"use client";

import type { MailboxShell } from "@invook/contracts";
import { createContext, useContext, type ReactNode } from "react";

const MailShellContext = createContext<MailboxShell | null>(null);

interface MailShellProviderProps {
  children: ReactNode;
  shell: MailboxShell;
}

export function MailShellProvider({ children, shell }: MailShellProviderProps) {
  return (
    <MailShellContext.Provider value={shell}>
      {children}
    </MailShellContext.Provider>
  );
}

export function useMailShell(): MailboxShell {
  const shell = useContext(MailShellContext);
  if (!shell) throw new Error("MailShellProvider is required.");
  return shell;
}
