/**
 * Where approving an agent sends the browser, described for the consent page.
 * An agent chooses its own display name when it registers, so the redirect
 * target is the part of the request a person can actually verify.
 */
export type AgentRedirectTarget =
  | { kind: "website"; host: string }
  | { kind: "this-computer" }
  | { kind: "app"; scheme: string };

/** Loopback hosts as Better Auth's redirect validation defines them. */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function describeAgentRedirectTarget(
  redirectUri: string,
): AgentRedirectTarget | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (isLoopbackHostname(url.hostname)) return { kind: "this-computer" };
    return url.protocol === "https:" ? { kind: "website", host: url.host } : null;
  }
  const scheme = url.protocol.slice(0, -1);
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? { kind: "app", scheme } : null;
}

export function formatAgentRedirectTarget(target: AgentRedirectTarget): string {
  switch (target.kind) {
    case "website":
      return target.host;
    case "this-computer":
      return "an app on this computer";
    case "app":
      return `the ${target.scheme} app on this device`;
  }
}
