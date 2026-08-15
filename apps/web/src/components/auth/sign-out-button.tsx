"use client";

import { Logout01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SignOutButtonProps {
  isIconOnly?: boolean;
  className?: string;
}

export function SignOutButton({
  isIconOnly = false,
  className,
}: SignOutButtonProps) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  const handleSignOut = async () => {
    setIsPending(true);
    try {
      await axios.post("/v1/auth/sign-out");
      router.replace("/");
      router.refresh();
    } catch {
      setIsPending(false);
    }
  };

  if (isIconOnly) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Sign out"
        disabled={isPending}
        className={cn(
          "text-sidebar-foreground/45 hover:bg-sidebar-accent hover:text-sidebar-foreground",
          className,
        )}
        onClick={() => void handleSignOut()}
      >
        <HugeiconsIcon icon={Logout01Icon} size={14} />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="secondary"
      disabled={isPending}
      className={className}
      onClick={() => void handleSignOut()}
    >
      {isPending ? "Signing out…" : "Sign out of Invook"}
    </Button>
  );
}
