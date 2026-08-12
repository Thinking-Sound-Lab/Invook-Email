import { buildApi } from "./app";
import { getApiHost, getApiPort } from "./config";

const api = await buildApi();
const host = getApiHost();
const port = getApiPort();
let closing = false;

async function shutDown(signal: NodeJS.Signals) {
  if (closing) return;
  closing = true;
  console.log(`api: received ${signal}, closing`);
  try {
    await api.close();
  } catch (error) {
    console.error("api: shutdown failed", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutDown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutDown("SIGTERM");
});

try {
  await api.listen({ host, port });
  console.log(`api: listening on http://${host}:${port}`);
} catch (error) {
  console.error("api: failed to start", error);
  process.exitCode = 1;
  await api.close();
}
