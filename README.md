# Invook

Invook is an open-source, AI-native Gmail client. It synchronizes and indexes the connected mailbox, applies an opinionated set of labels, and drafts replies using an inspectable Memory rather than a hidden writing profile.

The application starts with one Google sign-in action. Until a real Gmail account is connected, it shows an honest setup or empty state and never manufactures mailbox data.

## What works today

1. Direct Google OAuth authenticates the user and grants Gmail access.
2. The callback validates the Google identity, reads the Gmail profile, encrypts the provider credentials with AES-256-GCM, and creates a Gmail synchronization job.
3. The worker synchronizes the real mailbox by following every Gmail result page. Mail synchronization, search indexing, and writing-memory extraction have independent state.
4. A configured model applies Invook's predefined Important, Travel, Pitch, and Newsletter labels. A user's label changes take precedence over later model runs.
5. The worker sends full eligible email threads to the selected OpenAI or Azure OpenAI native Batch API. Incoming messages provide context and only the owner's eligible sent messages can become evidence for three kinds of Memory:
   - **Preferences:** repeated behavior that applies across contacts and should shape every draft.
   - **Contacts:** repeated communication behavior for one normalized email address.
   - **Scheduling:** repeated behavior used when coordinating meetings or times.
6. Settings → Memory lets the user add, edit, and delete every memory. Deleted text is removed; only a fingerprint remains to stop the same automatic inference from being recreated.
7. A reply draft receives the current thread plus applicable global, contact, and scheduling memories. It never receives unrelated contact memory.
8. Saving an edited AI draft records feedback. A new memory is proposed only when the same correction appears across at least three real drafts.
9. Historical subject/body embeddings use OpenAI Batch. Later stored messages use the regular OpenAI embeddings API with the same explicitly configured model, dimensions, content hash, and index version.
10. Search combines PostgreSQL full text, sender/recipient metadata, attachment filenames, and available vector similarity. Attachment contents are not downloaded or embedded.
11. The right sidebar runs a tool-using agent that can search mail, inspect a thread, list attachment metadata, and generate a saved reply draft with cited thread and message IDs.

Memory v3 does not depend on indexing or embeddings. Native Batch analysis discovers repeated writing behavior from complete thread context, while exact contact matching and memory type determine which small set of rules is supplied during drafting.

The right panel supports mailbox finding and reply drafting. Sending mail and autonomous inbox automations are not claimed as complete.

## Repository structure

```text
apps/
  web/                 Next.js App Router UI
  api/                 Native Node.js HTTP API, OAuth, sessions, and product endpoints
  worker/              Gmail sync, search indexing, labeling, Memory, and feedback jobs
packages/
  ai/                  Mail agent, OpenAI embeddings, Batch Memory, labels, feedback, and drafts
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

Initial Preferences, Contacts, and Scheduling analysis uses one native Batch provider selected by `MEMORY_BATCH_PROVIDER`. Invook creates one global request and one request per qualifying contact, then splits a scope only when the model input limit requires it. OpenAI requests use the Responses input-token endpoint for an exact count. Azure OpenAI does not expose that endpoint, so Invook uses the complete request's UTF-8 byte length as a conservative token-count upper bound against the deployment limit you configure. This Memory domain is separate from search indexing.

Search embeddings currently use OpenAI. Set `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, and `OPENAI_EMBEDDING_DIMENSIONS`; historical mail additionally requires `OPENAI_WEBHOOK_SECRET`. Registering the OpenAI Batch events below serves both Memory batches and embedding batches. The database uses pgvector, stores one vector per message subject/body, and keeps attachment metadata outside the embedding input.

For OpenAI, set `MEMORY_BATCH_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_WEBHOOK_SECRET`. Invook uses the pinned `gpt-5.4-nano-2026-03-17` model. Register these events in the [OpenAI project webhook settings](https://platform.openai.com/settings/project/webhooks):

- URL: `https://your-domain.example/v1/webhooks/openai`
- Events: `batch.completed`, `batch.failed`, `batch.expired`, and `batch.cancelled`

For Azure OpenAI, create a `Global-Batch` or `Data Zone Batch` deployment, then set `MEMORY_BATCH_PROVIDER=azure-openai`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_BATCH_DEPLOYMENT`, `AZURE_OPENAI_BATCH_INPUT_TOKEN_LIMIT`, and `AZURE_OPENAI_WEBHOOK_SECRET`. The deployment name is the JSONL `model` value. Its input-token limit is explicit because a custom Azure deployment name does not identify its backing model reliably. Register the same four events through the [Azure OpenAI webhook API](https://learn.microsoft.com/azure/foundry/openai/how-to/webhooks) using:

- URL: `https://your-domain.example/v1/webhooks/azure-openai`
- Events: `batch.completed`, `batch.failed`, `batch.expired`, and `batch.cancelled`

Both providers use Standard Webhooks. The API verifies the provider-specific signing secret and queues result processing; the worker does not poll. For a fully local run, expose the selected route through an HTTPS tunnel. If the selected Batch provider or general model is not configured, its jobs remain queued without fabricating output.

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

Drizzle ORM accesses PostgreSQL through the server-only `DATABASE_URL`. The same application code can use the local pgvector Docker image or a compatible hosted PostgreSQL database where the `vector` extension can be enabled.

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
