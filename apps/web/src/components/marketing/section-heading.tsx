import { cn } from "@/lib/utils";

export interface SectionHeadingProps {
  title: string;
  description?: string;
  align?: "start" | "center";
  className?: string;
}

export function SectionHeading({
  title,
  description,
  align = "center",
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        align === "center" && "mx-auto max-w-2xl items-center text-center",
        className,
      )}
    >
      <h2 className="text-balance text-[2rem] font-semibold leading-[1.1] tracking-[-0.04em] text-lp-ink sm:text-[2.75rem]">
        {title}
      </h2>
      {description ? (
        <p className="max-w-xl text-pretty text-base leading-7 text-lp-muted sm:text-lg">{description}</p>
      ) : null}
    </div>
  );
}
