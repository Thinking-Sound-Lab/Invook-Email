import { MarketingCta } from "./marketing-cta";
import { GITHUB_REPOSITORY_URL } from "./marketing-links";
import { SectionHeading } from "./section-heading";

const setupSteps = [
  {
    comment: "Clone and install",
    commands: [
      `git clone ${GITHUB_REPOSITORY_URL}.git`,
      "cd Invook-Email",
      "corepack enable",
      "pnpm install --frozen-lockfile",
    ],
  },
  {
    comment: "Add your Google, Temporal, and OpenAI settings",
    commands: ["cp .env.example .env.local"],
  },
  {
    comment: "Start Invook",
    commands: ["make dev"],
  },
] as const;

const selfHostRequirements = [
  "Docker Compose runs the web app, API, worker, PostgreSQL, and MinIO.",
  "Google OAuth with Gmail Pub/Sub handles sign-in and live sync.",
  "Temporal Cloud runs durable sync, and one OpenAI key powers labeling.",
] as const;

export function OpenSourceSection() {
  return (
    <section id="open-source" className="marketing-reveal mx-auto max-w-7xl px-6 pt-28 sm:pt-36">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div>
          <SectionHeading
            align="start"
            title="Open source, down to the last line"
            description="Invook is licensed under Apache 2.0. Read every line, then run it on infrastructure you choose."
          />
          <ul className="mt-8 space-y-3">
            {selfHostRequirements.map((requirement) => (
              <li key={requirement} className="text-sm leading-6 text-lp-muted">
                {requirement}
              </li>
            ))}
          </ul>
          <MarketingCta href={GITHUB_REPOSITORY_URL} className="mt-9">
            View on GitHub
          </MarketingCta>
        </div>

        <div className="dark rounded-3xl bg-background p-6 text-foreground shadow-2xl shadow-lp-ink/25 sm:p-8">
          <div className="space-y-6 overflow-x-auto">
            {setupSteps.map((step) => (
              <div key={step.comment}>
                <p className="text-xs font-medium text-muted-foreground">{step.comment}</p>
                <div className="mt-2 space-y-1">
                  {step.commands.map((command) => (
                    <p key={command} className="whitespace-nowrap text-sm font-medium tabular-nums">
                      {command}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
