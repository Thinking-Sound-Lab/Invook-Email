import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MemoryEntry, MemoryType } from "@invook/contracts";

import { Button } from "@/components/ui/button";

import { memoryDefinitions } from "./memory-definitions";
import { MemoryCard } from "./memory-card";

export interface MemoryListProps {
  type: MemoryType;
  memories: MemoryEntry[];
  onEdit: (memory: MemoryEntry) => void;
  onDelete: (memory: MemoryEntry) => Promise<void>;
  onAdd: () => void;
}

export function MemoryList({
  type,
  memories,
  onEdit,
  onDelete,
  onAdd,
}: MemoryListProps) {
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
        <MemoryCard key={memory.id} memory={memory} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}
