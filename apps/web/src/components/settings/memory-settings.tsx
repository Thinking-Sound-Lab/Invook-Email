"use client";

import {
  Add01Icon,
  Brain02Icon,
  Calendar03Icon,
  Delete02Icon,
  Edit02Icon,
  PreferenceHorizontalIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  AccountSyncStage,
  ApiProblem,
  MemoryEntry,
  MemoryType,
} from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const memoryDefinitions = {
  preference: {
    label: "Preferences",
    singular: "preference",
    icon: PreferenceHorizontalIcon,
    description: "Rules that should shape every reply Invook drafts.",
  },
  contact: {
    label: "Contacts",
    singular: "contact memory",
    icon: UserMultiple02Icon,
    description: "How you communicate with a specific email address.",
  },
  scheduling: {
    label: "Scheduling",
    singular: "scheduling memory",
    icon: Calendar03Icon,
    description: "How you coordinate meetings, times, and confirmations.",
  },
} satisfies Record<
  MemoryType,
  {
    label: string;
    singular: string;
    icon: typeof Brain02Icon;
    description: string;
  }
>;

async function responseError(response: Response, fallback: string) {
  try {
    const problem = (await response.json()) as Partial<ApiProblem>;
    return problem.title || fallback;
  } catch {
    return fallback;
  }
}

function evidenceLabel(memory: MemoryEntry): string {
  if (memory.source === "user") return "Added by you";
  if (memory.source === "feedback") {
    const count = memory.evidenceDraftIds.length;
    return `Learned from ${count} edited ${count === 1 ? "draft" : "drafts"}`;
  }
  const count = memory.evidenceMessageIds.length;
  return `Learned from ${count} sent ${count === 1 ? "email" : "emails"}`;
}

function sourceLabel(memory: MemoryEntry) {
  if (memory.source === "user") return "You";
  if (memory.source === "feedback") return "Feedback";
  return "Inferred";
}

function MemoryCard({
  memory,
  onEdit,
  onDelete,
}: {
  memory: MemoryEntry;
  onEdit: (memory: MemoryEntry) => void;
  onDelete: (memory: MemoryEntry) => Promise<void>;
}) {
  return (
    <article className="rounded-lg bg-card/65 px-4 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground/65" />
            <p className="min-w-0 text-sm leading-6 font-medium">
              {memory.statement}
            </p>
          </div>
          <p className="mt-1 pl-4 text-xs leading-5 text-muted-foreground">
            {memory.contactEmail ? `${memory.contactEmail} · ` : ""}
            {evidenceLabel(memory)} · {sourceLabel(memory)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Edit memory"
            onClick={() => onEdit(memory)}
          >
            <HugeiconsIcon icon={Edit02Icon} size={13} />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Delete memory"
              >
                <HugeiconsIcon icon={Delete02Icon} size={13} />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
                <AlertDialogDescription>
                  It will be removed from future drafts. Invook will also remember not to
                  recreate this exact inferred memory.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onDelete(memory)}>
                  Delete memory
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </article>
  );
}

function MemoryList({
  type,
  memories,
  onEdit,
  onDelete,
  onAdd,
}: {
  type: MemoryType;
  memories: MemoryEntry[];
  onEdit: (memory: MemoryEntry) => void;
  onDelete: (memory: MemoryEntry) => Promise<void>;
  onAdd: () => void;
}) {
  const definition = memoryDefinitions[type];
  if (memories.length === 0) {
    return (
      <div className="mt-5 rounded-xl bg-card/45 px-6 py-10 text-center">
        <span className="mx-auto grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
          <HugeiconsIcon icon={definition.icon} size={17} />
        </span>
        <p className="mt-3 text-sm font-medium">No {definition.label.toLowerCase()} yet</p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
          Add one yourself. Inferred memories appear only after repeated behavior is found
          in real sent email.
        </p>
        <Button type="button" className="mt-5" onClick={onAdd}>
          <HugeiconsIcon icon={Add01Icon} size={14} />
          Add {definition.singular}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-2">
      {memories.map((memory) => (
        <MemoryCard
          key={memory.id}
          memory={memory}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

export function MemorySettings({
  initialMemories,
  syncState,
  aiConfigured,
}: {
  initialMemories: MemoryEntry[];
  syncState: AccountSyncStage;
  aiConfigured: boolean;
}) {
  const router = useRouter();
  const [memories, setMemories] = useState(initialMemories);
  const [activeType, setActiveType] = useState<MemoryType>("preference");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [statement, setStatement] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusLabel =
    !aiConfigured && syncState !== "complete"
      ? "AI setup needed"
      : syncState === "complete"
      ? "Ready"
      : syncState === "failed"
        ? "Needs attention"
        : "Analyzing sent mail";

  function openAdd() {
    setEditing(null);
    setStatement("");
    setContactEmail("");
    setError(null);
    setEditorOpen(true);
  }

  function openEdit(memory: MemoryEntry) {
    setEditing(memory);
    setActiveType(memory.type);
    setStatement(memory.statement);
    setContactEmail(memory.contactEmail ?? "");
    setError(null);
    setEditorOpen(true);
  }

  async function saveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const endpoint = editing ? `/v1/memories/${editing.id}` : "/v1/memories";
    try {
      const response = await fetch(endpoint, {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: activeType,
          contactEmail: activeType === "contact" ? contactEmail : null,
          statement,
        }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response, "Invook could not save this memory."));
      }
      const body = (await response.json()) as { memory: MemoryEntry };
      setMemories((current) => {
        const withoutSaved = current.filter((memory) => memory.id !== body.memory.id);
        return [...withoutSaved, body.memory];
      });
      setEditorOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invook could not save this memory.");
    } finally {
      setPending(false);
    }
  }

  async function deleteMemory(memory: MemoryEntry) {
    setError(null);
    const response = await fetch(`/v1/memories/${memory.id}`, { method: "DELETE" });
    if (!response.ok) {
      setError(await responseError(response, "Invook could not delete this memory."));
      return;
    }
    setMemories((current) => current.filter((entry) => entry.id !== memory.id));
    router.refresh();
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <HugeiconsIcon icon={Brain02Icon} size={20} className="text-primary" />
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.03em]">Memory</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Used whenever Invook drafts</p>
            </div>
          </div>
          <p className="mt-5 max-w-xl text-sm leading-6 text-muted-foreground">
            Memory is the set of explicit and learned rules Invook applies to replies. You can
            add, correct, or delete every rule.
          </p>
          {!aiConfigured ? (
            <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
              Add an AI model to analyze sent mail. You can still add Memory yourself.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${
              syncState === "failed"
                ? "bg-destructive"
                : syncState === "complete"
                  ? "bg-success"
                  : "bg-primary"
            }`}
          />
          {statusLabel}
        </div>
      </div>

      <Tabs
        value={activeType}
        onValueChange={(value) => setActiveType(value as MemoryType)}
        className="mt-7"
      >
        <div className="flex items-center justify-between gap-3">
          <TabsList variant="line" className="h-9">
            {(Object.keys(memoryDefinitions) as MemoryType[]).map((type) => {
              const definition = memoryDefinitions[type];
              const count = memories.filter((memory) => memory.type === type).length;
              return (
                <TabsTrigger key={type} value={type} className="gap-1.5 px-3 text-[13px]">
                  <HugeiconsIcon icon={definition.icon} size={13} />
                  {definition.label}
                  <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>
          <Button type="button" size="sm" onClick={openAdd}>
            <HugeiconsIcon icon={Add01Icon} size={13} />
            Add
          </Button>
        </div>

        {(Object.keys(memoryDefinitions) as MemoryType[]).map((type) => (
          <TabsContent key={type} value={type}>
            <p className="mt-5 text-sm leading-6 text-muted-foreground">
              {memoryDefinitions[type].description}
            </p>
            <MemoryList
              type={type}
              memories={memories.filter((memory) => memory.type === type)}
              onEdit={openEdit}
              onDelete={deleteMemory}
              onAdd={openAdd}
            />
          </TabsContent>
        ))}
      </Tabs>

      {error && !editorOpen ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <form onSubmit={saveMemory}>
            <DialogHeader>
              <DialogTitle>
                {editing ? "Edit" : "Add"} {memoryDefinitions[activeType].singular}
              </DialogTitle>
              <DialogDescription>
                Write one clear rule. User-written changes always take priority over inferred
                memory.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-5 space-y-4">
              {activeType === "contact" ? (
                <label className="block space-y-1.5 text-sm font-medium">
                  Email address
                  <Input
                    type="email"
                    required
                    value={contactEmail}
                    onChange={(event) => setContactEmail(event.target.value)}
                    autoComplete="off"
                  />
                </label>
              ) : null}
              <label className="block space-y-1.5 text-sm font-medium">
                Memory
                <Textarea
                  required
                  minLength={3}
                  maxLength={500}
                  value={statement}
                  onChange={(event) => setStatement(event.target.value)}
                  className="min-h-28 resize-none"
                  autoFocus={activeType !== "contact"}
                />
              </label>
            </div>

            {error ? (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditorOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save memory"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
