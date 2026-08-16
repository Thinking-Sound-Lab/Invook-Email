"use client";

import { GoogleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import axios from "axios";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type GoogleSignInResponse = {
  redirect: boolean;
  url?: string;
};

export function GoogleSignInButton() {
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSignIn = async () => {
    setError(null);
    setIsPending(true);
    try {
      const response = await axios.post<GoogleSignInResponse>(
        "/v1/auth/sign-in/social",
        {
          provider: "google",
          callbackURL: "/",
          errorCallbackURL: "/auth/error?reason=identity",
        },
      );
      if (!response.data.redirect || !response.data.url) {
        throw new Error("Google sign-in did not return a redirect.");
      }
      window.location.assign(response.data.url);
    } catch {
      setError("Invook could not start Google sign-in.");
      setIsPending(false);
    }
  };

  return (
    <div className="w-full">
      <Button
        type="button"
        size="lg"
        className="h-11 w-full gap-2.5"
        disabled={isPending}
        onClick={() => void handleSignIn()}
      >
        <HugeiconsIcon icon={GoogleIcon} size={18} strokeWidth={1.7} />
        {isPending ? "Opening Google…" : "Sign in with Google"}
      </Button>
      {error ? (
        <p className="mt-3 text-center text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
