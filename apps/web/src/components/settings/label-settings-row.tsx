import {
  Delete02Icon,
  Tick02Icon,
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
  name: string;
  description: string;
  status: string;
  deleting: boolean;
  onDelete?: () => Promise<void>;
}

export function LabelSettingsRow({
  name,
  description,
  status,
  deleting,
  onDelete,
}: LabelSettingsRowProps) {
  return (
    <article className="group flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/35">
      <span className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-primary text-primary-foreground">
        <HugeiconsIcon
          icon={Tick02Icon}
          size={11}
          strokeWidth={2.4}
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
          Invook
        </p>
        <p className="mt-0.5 max-w-40 truncate text-[10px] text-muted-foreground">
          {status}
        </p>
      </div>

      {onDelete ? (
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
                This removes the Invook label and all of its automatic and manual
                thread decisions.
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
      ) : (
        <span className="w-7 shrink-0" aria-label={`${name} cannot be deleted`} />
      )}
    </article>
  );
}
