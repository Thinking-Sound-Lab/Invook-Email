import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGeminiBatchWebhook } from "@invook/ai";

const arguments_ = process.argv.slice(2);
const writeEnvironment = arguments_.includes("--write-env");
const uri = arguments_.find((argument) => !argument.startsWith("--"))?.trim();
if (!uri) {
  throw new Error(
    "Pass the public HTTPS callback URL, ending in /v1/webhooks/gemini.",
  );
}

const environmentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.env.local",
);
const currentEnvironment = writeEnvironment
  ? await readFile(environmentPath, "utf8")
  : null;
if (
  currentEnvironment !== null &&
  !/^GEMINI_WEBHOOK_SECRET=.*$/m.test(currentEnvironment)
) {
  throw new Error(".env.local does not contain GEMINI_WEBHOOK_SECRET.");
}

const webhook = await createGeminiBatchWebhook(uri);
console.log(`Gemini webhook created: ${webhook.id}`);
if (currentEnvironment !== null) {
  const updatedEnvironment = currentEnvironment.replace(
    /^GEMINI_WEBHOOK_SECRET=.*$/m,
    () => `GEMINI_WEBHOOK_SECRET=${webhook.signingSecret}`,
  );
  await writeFile(environmentPath, updatedEnvironment, { mode: 0o600 });
  console.log("The signing secret was stored in .env.local.");
} else {
  console.log("Add this one-time value to GEMINI_WEBHOOK_SECRET:");
  console.log(webhook.signingSecret);
}
