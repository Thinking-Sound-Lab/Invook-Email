import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalStyles = readFileSync(
  new URL("../../app/globals.css", import.meta.url),
  "utf8",
);

test("global theme keeps Plus Jakarta Sans and explicit light and dark color schemes", () => {
  assert.match(
    globalStyles,
    /--font-sans: "Plus Jakarta Sans", "Plus Jakarta Sans Fallback"/,
  );
  assert.match(globalStyles, /:root \{[\s\S]*?color-scheme: light;/);
  assert.match(globalStyles, /\.dark \{[\s\S]*?color-scheme: dark;/);
  assert.doesNotMatch(globalStyles, /--font-sans:\s*var\(--font-sans\)/);
});

test("light and dark themes both define the shared shadcn surface tokens", () => {
  const requiredTokens = [
    "--background",
    "--foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--popover-foreground",
    "--primary",
    "--primary-foreground",
    "--border",
    "--input",
    "--ring",
  ];

  const rootTheme = globalStyles.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const darkTheme = globalStyles.match(/\.dark \{([\s\S]*?)\n\}/)?.[1] ?? "";

  for (const token of requiredTokens) {
    assert.match(rootTheme, new RegExp(`${token}:`));
    assert.match(darkTheme, new RegExp(`${token}:`));
  }
});
