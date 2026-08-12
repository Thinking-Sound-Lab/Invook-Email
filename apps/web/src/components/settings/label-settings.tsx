"use client";

import {
  Add01Icon,
  Delete02Icon,
  Tag01Icon,
  TagsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MailLabel } from "@invook/contracts";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/http-error";

function LabelCard({
  label,
  batchConfigured,
  deleting,
  onDelete,
}: {
  label: MailLabel;
  batchConfigured: boolean;
  deleting: boolean;
  onDelete: (label: MailLabel) => Promise<void>;
}) {
  const percentage =
    label.totalThreadCount === 0
      ? label.analysisState === "complete"
        ? 100
        : 0
      : Math.round((label.analyzedThreadCount / label.totalThreadCount) * 100);
  const status =
    label.analysisState === "complete"
      ? `${label.analyzedThreadCount} ${label.analyzedThreadCount === 1 ? "thread" : "threads"} analyzed`
      : label.analysisState === "failed"
        ? "Analysis needs attention"
        : !batchConfigured
          ? "Waiting for Batch setup"
          : label.analysisState === "running"
            ? `${label.analyzedThreadCount} of ${label.totalThreadCount} threads analyzed`
            : "Analysis queued";

  return (
    <article className="rounded-lg bg-card/65 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
          <HugeiconsIcon icon={Tag01Icon} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-semibold">{label.name}</p>
            <div className="flex items-center gap-1.5">
              <p className="text-xs tabular-nums text-muted-foreground">{status}</p>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${label.name}`}
                    disabled={deleting}
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={13} />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {label.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes the label and all of its automatic and manual thread
                      decisions. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="border-0">
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={deleting}
                      onClick={() => void onDelete(label)}
                    >
                      Delete label
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {label.description}
          </p>
          {label.analysisState !== "complete" ? (
            <Progress
              value={percentage}
              aria-label={`${label.name} analysis progress`}
              className="mt-3 h-1 bg-secondary"
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function LabelSettings({
  initialLabels,
  batchConfigured,
}: {
  initialLabels: MailLabel[];
  batchConfigured: boolean;
}) {
  const router = useRouter();
  const [labels, setLabels] = useState(initialLabels);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [deletingLabelId, setDeletingLabelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openEditor() {
    setName("");
    setDescription("");
    setError(null);
    setOpen(true);
  }

  async function createLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await axios.post<{ label: MailLabel }>("/v1/labels", {
        name,
        description,
      });
      const body = response.data;
      setLabels((current) => [...current, body.label]);
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not create this label."));
    } finally {
      setPending(false);
    }
  }

  async function deleteLabel(label: MailLabel) {
    setDeletingLabelId(label.id);
    setError(null);
    try {
      await axios.delete(`/v1/labels/${label.id}`);
      setLabels((current) => current.filter((entry) => entry.id !== label.id));
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not delete this label."));
    } finally {
      setDeletingLabelId(null);
    }
  }

  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
            <HugeiconsIcon icon={TagsIcon} size={17} />
          </span>
          <div>
            <h2 className="text-base font-semibold tracking-[-0.02em]">Labels</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
              Invook checks every indexed Gmail thread against each description. New labels
              are analyzed through the configured Batch provider.
            </p>
          </div>
        </div>
        <Button type="button" size="sm" onClick={openEditor}>
          <HugeiconsIcon icon={Add01Icon} size={14} />
          New label
        </Button>
      </div>

      <div className="mt-6 space-y-2">
        {labels.map((label) => (
          <LabelCard
            key={label.id}
            label={label}
            batchConfigured={batchConfigured}
            deleting={deletingLabelId === label.id}
            onDelete={deleteLabel}
          />
        ))}
        {labels.length === 0 ? (
          <div className="rounded-xl bg-card/45 px-6 py-10 text-center">
            <p className="text-sm font-medium">No labels</p>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Create a label when you want Invook to classify indexed Gmail threads.
            </p>
          </div>
        ) : null}
        {error && !open ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={createLabel}>
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
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !name.trim() || !description.trim()}>
                {pending ? "Creating…" : "Create label"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
