"use client";

import type { CreateMailLabelRequest } from "@invook/contracts";
import { useState, type FormEvent } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/http-error";

export interface CreateLabelDialogProps {
  onClose: () => void;
  onCreate: (request: CreateMailLabelRequest) => Promise<void>;
}

export function CreateLabelDialog({ onClose, onCreate }: CreateLabelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onCreate({ name, description });
      setPending(false);
      onClose();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not create this label."));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create a label</DialogTitle>
            <DialogDescription>
              Give the label a precise description. The AI uses that description as its
              complete classification rule.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="label-name" className="text-xs font-medium">
                Name
              </label>
              <Input
                id="label-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="label-description" className="text-xs font-medium">
                What belongs in this label?
              </label>
              <Textarea
                id="label-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="min-h-28 resize-none"
                required
              />
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter className="mt-5 border-0">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim() || !description.trim()}>
              {pending ? "Creating…" : "Create label"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
