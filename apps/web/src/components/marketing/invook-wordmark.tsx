import { cn } from "@/lib/utils";

export interface InvookWordmarkProps {
  className?: string;
}

export function InvookWordmark({ className }: InvookWordmarkProps) {
  return (
    <span className={cn("text-xl font-bold tracking-[-0.05em] text-lp-ink", className)}>
      Invook
    </span>
  );
}
