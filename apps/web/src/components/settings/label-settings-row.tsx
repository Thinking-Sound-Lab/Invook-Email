import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LabelHistoryWindowDays } from "@invook/contracts";

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
  isEnabled: boolean;
  canDisable: boolean;
  isPending: boolean;
  onDisable: () => Promise<void>;
  onEnable: (applyToPastDays: LabelHistoryWindowDays | null) => Promise<void>;
}

export function LabelSettingsRow({
  name,
  description,
  status,
  isEnabled,
  canDisable,
  isPending,
  onDisable,
  onEnable,
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

      {!canDisable ? (
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
          Always enabled
        </span>
      ) : isEnabled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => void onDisable()}
          className="text-xs text-muted-foreground"
        >
          Disable
        </Button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              className="text-xs text-muted-foreground"
            >
              Enable
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Enable {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                New Inbox threads will consider this label. Choose whether Invook
                should also rescan existing Inbox threads from a recent time window.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-wrap border-0">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void onEnable(null)}>
                New threads only
              </AlertDialogAction>
              {([7, 30, 90] as const).map((days) => (
                <AlertDialogAction
                  key={days}
                  onClick={() => void onEnable(days)}
                >
                  Past {days} days
                </AlertDialogAction>
              ))}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </article>
  );
}
