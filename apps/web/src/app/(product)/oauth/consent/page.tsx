import { MCP_MAIL_SCOPE, MCP_OFFLINE_ACCESS_SCOPE } from "@invook/contracts";
import { connection } from "next/server";

import { AgentConsentForm } from "@/components/auth/agent-consent-form";
import {
  describeAgentRedirectTarget,
  formatAgentRedirectTarget,
} from "@/components/auth/agent-redirect-target";
import { getAgentClientName, getSessionState } from "@/lib/api";

type AgentConsentPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const MAIL_SCOPE_ABILITIES = [
  "Read and search mail in every Gmail account you connected to Invook",
  "Archive threads and mark them read or unread",
  "Save drafts and send email as you",
];

function readParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ConsentMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-4xl font-semibold tracking-[-0.05em]">Invook</h1>
        <p className="mt-8 text-sm font-medium">{title}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
      </div>
    </main>
  );
}

export default async function AgentConsentPage({ searchParams }: AgentConsentPageProps) {
  await connection();
  const params = await searchParams;
  const clientId = readParam(params.client_id);
  const redirectUri = readParam(params.redirect_uri);
  const scopes = (readParam(params.scope) ?? "").split(" ").filter(Boolean);
  if (!clientId || !redirectUri || !readParam(params.sig)) {
    return (
      <ConsentMessage
        title="This connection request is incomplete"
        detail="Start connecting Invook from your agent again."
      />
    );
  }

  const session = await getSessionState();
  if (!session.authenticated) {
    return (
      <ConsentMessage
        title="Your Invook sign-in ended"
        detail="Start connecting Invook from your agent again to sign in."
      />
    );
  }
  const client = await getAgentClientName(clientId);
  if (!client) {
    return (
      <ConsentMessage
        title="This agent is not registered with Invook"
        detail="Start connecting Invook from your agent again."
      />
    );
  }

  const agentName = client.name ?? "An unnamed agent";
  const target = describeAgentRedirectTarget(redirectUri);

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-4xl font-semibold tracking-[-0.05em]">Invook</h1>
        <h2 className="mt-10 text-lg font-semibold tracking-[-0.02em]">
          Allow {agentName} to use your mail?
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {target
            ? `After you decide, Invook returns you to ${formatAgentRedirectTarget(target)}. Allow only agents you started connecting yourself.`
            : "This agent asked to return to an address that is not secure, so Invook will not connect it."}
        </p>

        {target ? (
          <ul className="mt-6 space-y-2.5 rounded-xl bg-card/65 p-5 text-sm leading-6">
            {scopes.includes(MCP_MAIL_SCOPE)
              ? MAIL_SCOPE_ABILITIES.map((ability) => <li key={ability}>{ability}</li>)
              : null}
            {scopes.includes(MCP_OFFLINE_ACCESS_SCOPE) ? (
              <li>Stay connected until you disconnect it</li>
            ) : null}
          </ul>
        ) : null}

        {target && !session.gmailConnected ? (
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            You have not connected a Gmail account yet, so the agent will find no
            mail until you do.
          </p>
        ) : null}
        {target ? (
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Invook marks sending as an action that needs your confirmation, and the
            agent asks for it according to its own settings. Disconnect an agent
            anytime in Invook under Settings, Agents.
          </p>
        ) : null}

        <AgentConsentForm agentName={agentName} canApprove={target !== null} />
      </div>
    </main>
  );
}
