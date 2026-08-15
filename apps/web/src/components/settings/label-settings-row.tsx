import {
  AiMagicIcon,
  Delete02Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

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

export interface LabelSettingsRowProps {
  kind: "gmail" | "invook";
  name: string;
  description: string;
  status: string;
  deleting: boolean;
  onDelete: () => Promise<void>;
}

export function LabelSettingsRow({
  kind,
  name,
  description,
  status,
  deleting,
  onDelete,
}: LabelSettingsRowProps) {
  const isGmailLabel = kind === "gmail";

  return (
    <article className="group flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/35">
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-md ${
          isGmailLabel
            ? "bg-secondary text-muted-foreground"
            : "bg-primary/12 text-primary"
        }`}
      >
        <HugeiconsIcon
          icon={isGmailLabel ? Tag01Icon : AiMagicIcon}
          size={14}
          strokeWidth={1.8}
        />
      </span>

      <div className="min-w-0 flex-1 md:flex md:items-baseline md:gap-2.5">
        <p className="shrink-0 truncate text-[13px] font-semibold md:max-w-44">
          {name}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground md:mt-0">
          {description}
        </p>
      </div>

      <div className="hidden shrink-0 text-right lg:block">
        <p className="text-[11px] font-medium text-foreground/65">
          {isGmailLabel ? "Gmail" : "Invook"}
        </p>
        <p className="mt-0.5 max-w-40 truncate text-[10px] text-muted-foreground">
          {status}
        </p>
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Delete ${name}`}
            disabled={deleting}
            className="text-muted-foreground opacity-70 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
          >
            <HugeiconsIcon icon={Delete02Icon} size={13} />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {isGmailLabel
                ? "This deletes the label in Gmail and removes it from every message. The messages themselves are not deleted."
                : "This removes the Invook label and all of its automatic and manual thread decisions."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="border-0">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={deleting} onClick={() => void onDelete()}>
              Delete label
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
