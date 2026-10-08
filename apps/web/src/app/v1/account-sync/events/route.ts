import { proxyEventStream } from "@/lib/event-stream-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  return proxyEventStream(request, "/v1/account-sync/events");
}
