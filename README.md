# Invook

Invook is an open-source, AI-native Gmail client. It indexes the connected mailbox, applies an opinionated set of labels, and drafts replies using an inspectable Memory rather than a hidden writing profile.

The application starts with one Google sign-in action. Until a real Gmail account is connected, it shows an honest setup or empty state and never manufactures mailbox data.

## What works today

1. Direct Google OAuth authenticates the user and grants Gmail access.
2. The callback validates the Google identity, reads the Gmail profile, encrypts the provider credentials with AES-256-GCM, and creates an indexing job.
3. The worker indexes the real mailbox by following every Gmail result page.
4. A configured model applies Invook's predefined Important, Travel, Pitch, and Newsletter labels. A user's label changes take precedence over later model runs.
5. The worker sends full eligible email threads to Gemini's native Batch API. Incoming messages provide context and only the owner's eligible sent messages can become evidence for three kinds of Memory:
   - **Preferences:** repeated behavior that applies across contacts and should shape every draft.
   - **Contacts:** repeated communication behavior for one normalized email address.
   - **Scheduling:** repeated behavior used when coordinating meetings or times.
6. Settings → Memory lets the user add, edit, and delete every memory. Deleted text is removed; only a fingerprint remains to stop the same automatic inference from being recreated.
7. A reply draft receives the current thread plus applicable global, contact, and scheduling memories. It never receives unrelated contact memory.
8. Saving an edited AI draft records feedback. A new memory is proposed only when the same correction appears across at least three real drafts.

Memory v2 does not require embeddings. This is deliberate: Gemini Batch discovers repeated behavior from complete thread context, while exact contact matching and memory type determine which small set of rules is supplied during drafting. PostgreSQL full-text search remains available for exact mailbox search.

The right panel currently communicates the agent's Find, Write, and Automate responsibilities. General conversational actions and sending mail are not claimed as complete yet.

## Repository structure

```text
apps/
  web/                 Next.js App Router UI
  api/                 Native Node.js HTTP API, OAuth, sessions, and product endpoints
  worker/              Gmail indexing, labeling, Memory extraction, and feedback jobs
packages/
  ai/                  Gemini Batch Memory analysis plus structured labels, feedback, and drafts
  contracts/           Shared JSON API types
  database/            Drizzle schema, migrations, repositories, and credential encryption
  gmail/               Gmail API client, OAuth scopes, and MIME parsing
docker/
  Dockerfile           Web, API, and worker image targets
  compose.yml          Complete local service stack
  dev-local.sh         Local Docker startup
docs/
  product-requirements.md
  competitive-research.md
```

The frontend uses shadcn/ui source components, the free Hugeicons package, Plus Jakarta Sans, and a Notion-inspired dark palette.

## Google OAuth setup

Create a Google Cloud OAuth web application and enable the Gmail API. Configure these authorized redirect URIs:

- Local: `http://localhost:3000/auth/callback`
- Hosted: `https://your-domain.example/auth/callback`

Copy the environment template and fill every blank value:

```bash
cp .env.example .env.local
openssl rand -base64 32
```

Put the generated value in `TOKEN_ENCRYPTION_KEY`. Invook uses the official Google OAuth client directly; it does not use Supabase Auth.

## Model setup

Labeling, feedback analysis, and drafting use an OpenAI-compatible HTTP endpoint. Set `AI_BASE_URL` and `AI_MODEL`; `AI_API_KEY` is optional for a local model. When the worker runs in Docker and a local model runs on the host, use a host-reachable URL such as `http://host.docker.internal:11434/v1`.

Initial Preferences, Contacts, and Scheduling analysis uses `gemini-3.5-flash-lite` through the official Gemini Batch API. Set `GEMINI_API_KEY` for a Google AI Studio project with active billing; Batch capacity starts at paid Tier 1. Invook creates one global request and one request per qualifying contact; it splits a request only when the model's reported context limit requires it. There is no mandatory second analysis batch and no embedding step.

Gemini reports completion to `POST /v1/webhooks/gemini`. The API verifies the Standard Webhooks signature and queues result processing; the worker does not poll. Expose that route at a public HTTPS URL, then register it once:

```bash
pnpm gemini:webhook:create -- https://your-domain.example/v1/webhooks/gemini
```

Copy the one-time signing secret printed by the command into `GEMINI_WEBHOOK_SECRET`. Add `--write-env` to store it directly in `.env.local` without printing it. For a fully local run, use an HTTPS tunnel to the local app and register the tunnel URL. If Gemini or the general model is not configured, the corresponding jobs remain queued without fabricating output.

## Run locally with Docker

Requirements: Node.js 22+, pnpm 11+, and Docker Desktop. Corepack installs the pnpm version pinned in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
make dev
```

Open [http://localhost:3000](http://localhost:3000). The stack starts PostgreSQL, applies the Drizzle migrations, and runs the web, API, and worker services.

Stop it with:

```bash
make down
```

## Run application processes outside Docker

Use the same root `.env.local`:

```bash
pnpm dev
```

Start the worker in a second terminal:

```bash
pnpm worker
```

## Database and migrations

Drizzle ORM accesses PostgreSQL through the server-only `DATABASE_URL`. The same application code can use local Docker PostgreSQL or a compatible hosted PostgreSQL database.

After changing `packages/database/src/schema.ts`:

```bash
pnpm db:generate
pnpm db:migrate
```

Inspect every generated SQL migration before applying it. `packages/database/drizzle` is the canonical migration history.

## Verify changes

```bash
make verify
docker compose -f docker/compose.yml config --quiet
```

## Data and security boundaries

- Provider tokens are encrypted and never sent to the browser.
- Database credentials and account secrets are server-only.
- Google identities are validated server-side and mapped to stable Invook user IDs.
- Session cookies are signed, HTTP-only, and contain no provider token.
- Next.js contains UI only. It reaches the native Node API through `/v1`; only the API and worker import database and Gmail packages.
- Product reads are scoped by user ID. Worker operations use explicit account and job IDs.
- Email content is treated as untrusted input in every model prompt.
- Inferred Memory requires evidence from at least three messages; global preferences additionally require evidence across at least three contacts.
- User-written memory wins over inferred memory.

## Project documents

- [Product requirements](./docs/product-requirements.md)
- [Competitive research](./docs/competitive-research.md)

The project license has not been selected yet. Do not assume reuse rights until a license is added.
