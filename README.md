# Invook

Invook is an open-source, AI-native Gmail client. It keeps a lossless local Gmail mailbox replica, applies user-created Invook labels, and drafts replies using an inspectable Memory rather than a hidden writing profile.

The application starts with Google Identity sign-in through Better Auth. That flow requests only `openid`, `email`, and `profile`. Gmail authorization is a separate, authenticated mailbox-connection flow, so signing into Invook never grants mailbox access.

## What works today

1. Better Auth owns global Google Identity users and database-backed browser sessions. Its OAuth client requests identity scopes only and never receives Gmail access.
2. An authenticated user can separately add or reconnect Gmail mailboxes through a dedicated Google OAuth authorization flow. On first connection, the callback validates the mailbox identity, captures H0, registers a Gmail watch, encrypts the Gmail credentials with AES-256-GCM, and transactionally records exactly one replica run plus its first BullMQ step. Reconnection refreshes only the selected mailbox credential and preserves durable replica/watch/run state. Signing out clears only the Better Auth session.
3. A sequential page worker discovers every message in 500-result pages, including Spam and Trash, while configurable parallel per-message workers fetch exact raw MIME. Raw MIME and attachment bytes go to S3-compatible object storage with checksums; PostgreSQL stores complete headers, text/HTML, recognized Gmail system memberships, Gmail Draft resources, watch state, pending/applied history cursors, and workflow checkpoints. Each committed message atomically creates its own label-analysis job. Finalization replays history from H0, performs a final locked catch-up, and only then releases indexing and initial Memory.
4. One structured per-message classifier independently evaluates the built-in Newsletter definition and active custom Invook labels. Label creation first previews matches from up to 100 recent canonical stored messages and may optionally enqueue a durable scan of stored mail from the last 7, 30, or 90 days. Without that explicit choice, creation and editing remain forward-only. Important comes only from Gmail. Others is derived after successful analysis only when neither Important nor any Invook label applies, and opaque Gmail user-label IDs are ignored. Applied relationships and explicit user overrides are persisted per message; thread display is calculated from visible messages.
5. Initial Memory analysis sends all eligible email threads to the selected OpenAI or Azure OpenAI native Batch API. Later eligible owner-sent messages accumulate as targeted global and contact evidence without rescanning the original mailbox. Incoming messages provide context and only the owner's eligible sent messages can become evidence for three kinds of Memory:
   - **Preferences:** repeated behavior that applies across contacts and should shape every draft.
   - **Contacts:** repeated communication behavior for one normalized email address.
   - **Scheduling:** repeated behavior used when coordinating meetings or times.
6. Settings → Memory lets the user add, edit, and delete every memory. Deleted text is removed; only a fingerprint remains to stop the same automatic inference from being recreated.
7. A reply draft receives the current thread plus applicable global, contact, and scheduling memories. It never receives unrelated contact memory.
8. Saving an edited AI draft records feedback. A new memory is proposed only when the same correction appears across at least three real drafts.
9. Historical subject/body embeddings use OpenAI Batch. Later stored messages use the regular OpenAI embeddings API with the same explicitly configured model, dimensions, content hash, and index version.
10. Search combines PostgreSQL full text, sender/recipient metadata, attachment filenames, and available vector similarity. Attachment bytes are replicated to object storage but are not embedded.
11. The right sidebar runs a tool-using agent that can search mail, inspect a thread, list attachment metadata, and generate a saved reply draft with cited thread and message IDs. Its typed mailbox query resolves search text, Gmail and Invook labels, Inbox/read state, sender, dates, and pagination only against the ready local replica.
12. The agent is read-only with respect to Gmail: it can find mail and create local reply drafts, but it cannot mutate provider state. Explicit product actions write Gmail-backed state to Gmail first and converge locally through stored-cursor history catch-up.
13. New-message Compose saves and updates Gmail Draft resources, then exposes a separate explicit confirmation before sending that exact provider draft. A durable idempotency record prevents duplicate sends, ambiguous responses recover from Gmail state without resending, and stored-cursor history catch-up converges the sent message into the replica.

BullMQ is the only job executor. Purpose-specific queues execute Gmail synchronization, Pub/Sub history catch-up, daily watch renewal, exceptional repair runs, object cleanup, search indexing, Invook-label analysis, and initial or targeted Memory work published through the transactional PostgreSQL outbox. PostgreSQL retains workflow/progress state and provider Batch correlation; notifications wake outbox and SSE consumers. No path uses timer-based polling.

Memory v3 does not depend on search embeddings. Native Batch analysis discovers repeated writing behavior from complete thread context, while exact contact matching and memory type determine which small set of rules is supplied during drafting.

The right panel supports mailbox finding and local reply drafting. It does not expose Gmail mutation tools. Agent-initiated sending and autonomous inbox automations are not claimed as complete; sending is available only through the user-confirmed Compose flow.

## Repository structure

```text
apps/
  web/                 Next.js App Router UI
  api/                 Fastify API, OAuth, sessions, and product endpoints
  worker/              Gmail sync, search indexing, labeling, Memory, and feedback jobs
packages/
  ai/                  Mail agent, OpenAI embeddings, Batch Memory, labels, feedback, and drafts
  contracts/           Shared JSON API types
  database/            Drizzle schema, migrations, repositories, and credential encryption
  gmail/               Gmail API client, OAuth scopes, and MIME parsing
  auth/                Better Auth Google Identity and database sessions
  object-storage/      Axios/SigV4 S3-compatible raw MIME and attachment storage
docker/
  Dockerfile           Web, API, and worker image targets
  compose.yml          Complete local service stack
  dev-local.sh         Local Docker startup
docs/
  gmail-replica-contract.md
  product-requirements.md
```

The frontend uses shadcn/ui source components, the free Hugeicons package, Plus Jakarta Sans, and a Notion-inspired dark palette.

## Google Identity and Gmail OAuth setup

One Google Cloud OAuth web client can serve both flows because each authorization request selects its own scopes. You may use two clients in production to isolate credential rotation and redirect configuration, but the security boundary is the separate flow and enforced scope set rather than the client ID.

The Better Auth identity client requests only `openid`, `email`, and `profile`. Configure:

- Local: `http://localhost:3000/v1/auth/callback/google`
- Hosted: `https://your-domain.example/v1/auth/callback/google`

Set `BETTER_AUTH_GOOGLE_CLIENT_ID`, `BETTER_AUTH_GOOGLE_CLIENT_SECRET`, and an independent `BETTER_AUTH_SECRET`.

Enable the Gmail API for the Gmail connection client and configure:

- Local: `http://localhost:3000/connections/gmail/callback`
- Hosted: `https://your-domain.example/connections/gmail/callback`

Set `GMAIL_GOOGLE_CLIENT_ID` and `GMAIL_GOOGLE_CLIENT_SECRET`. To reuse one Google OAuth client, set both environment-variable pairs to the same client ID and secret and register both callback URLs on that client.

Copy the environment template and fill every blank value:

```bash
cp .env.example .env.local
openssl rand -base64 32
```

Generate separate values for `BETTER_AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`. Better Auth owns global identity and sessions; Invook's Gmail package owns mailbox authorization and encrypted provider credentials.

Continuous Gmail synchronization also needs a Google Pub/Sub topic and an authenticated push subscription targeting `https://your-domain.example/v1/webhooks/google-pubsub`. Set `GMAIL_PUBSUB_TOPIC`, the subscription's OIDC audience in `GOOGLE_PUBSUB_PUSH_AUDIENCE`, its service-account email in `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`, and the full subscription name in `GOOGLE_PUBSUB_SUBSCRIPTION`. Gmail connection stays unavailable until these real resources are configured.

## Model setup

Feedback analysis and drafting use an OpenAI-compatible HTTP endpoint. Set `AI_BASE_URL` and `AI_MODEL`; `AI_API_KEY` is optional for a local model. When the worker runs in Docker and a local model runs on the host, use a host-reachable URL such as `http://host.docker.internal:11434/v1`.

Per-message label analysis uses the OpenAI-compatible endpoint configured by `AI_BASE_URL`, `AI_MODEL`, and optional `AI_API_KEY`. It runs on its own `mail-label-submit` queue, bounded by `MAIL_LABEL_CONCURRENCY`, and never receives raw MIME, HTML, attachments, or Gmail provider payloads. Preferences, Contacts, and Scheduling analysis use the native Batch provider selected by `MEMORY_BATCH_PROVIDER`. Initial Memory analysis creates one global request and one request per qualifying contact; later Memory jobs contain only accumulated post-indexing evidence for the qualifying scope. A scope is split only when the model input limit requires it. OpenAI requests use the Responses input-token endpoint for an exact count. Azure OpenAI does not expose that endpoint, so Invook uses the complete request's UTF-8 byte length as a conservative token-count upper bound against the deployment limit you configure.

Search embeddings currently use OpenAI. Set `OPENAI_API_KEY` and `OPENAI_EMBEDDING_MODEL`; `OPENAI_EMBEDDING_DIMENSIONS` must remain `1536` for the indexed pgvector column. Historical mail additionally requires `OPENAI_WEBHOOK_SECRET`. Registering the OpenAI Batch events below serves both Memory batches and embedding batches. Historical indexing advances in durable 2,000-message submissions: each terminal webhook atomically records only current-content results, closes the correlated provider submission, and publishes the next batch while eligible messages remain. The database stores one HNSW-indexed vector per message subject/body and keeps attachment metadata outside the embedding input.

For OpenAI, set `MEMORY_BATCH_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_WEBHOOK_SECRET`. Invook uses the pinned `gpt-5.4-nano-2026-03-17` model. Register these events in the [OpenAI project webhook settings](https://platform.openai.com/settings/project/webhooks):

- URL: `https://your-domain.example/v1/webhooks/openai`
- Events: `batch.completed`, `batch.failed`, `batch.expired`, and `batch.cancelled`

For Azure OpenAI, create a `Global-Batch` or `Data Zone Batch` deployment, then set `MEMORY_BATCH_PROVIDER=azure-openai`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_BATCH_DEPLOYMENT`, `AZURE_OPENAI_BATCH_INPUT_TOKEN_LIMIT`, and `AZURE_OPENAI_WEBHOOK_SECRET`. The deployment name is the JSONL `model` value. Its input-token limit is explicit because a custom Azure deployment name does not identify its backing model reliably. Register the same four events through the [Azure OpenAI webhook API](https://learn.microsoft.com/azure/foundry/openai/how-to/webhooks) using:

- URL: `https://your-domain.example/v1/webhooks/azure-openai`
- Events: `batch.completed`, `batch.failed`, `batch.expired`, and `batch.cancelled`

Both providers use Standard Webhooks. The API verifies the provider-specific signing secret and queues result processing; the worker does not poll. For a fully local run, expose the selected route through an HTTPS tunnel. If the selected Memory Batch provider is not configured, its jobs remain queued without fabricating output. Per-message label jobs retry boundedly; terminal model unavailability becomes an explicit failed-but-visible mailbox state without fabricated labels.

## Run locally with Docker

Requirements: Node.js 22+, pnpm 11+, and Docker Desktop. Corepack installs the pnpm version pinned in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
make dev
```

Open [http://localhost:3000](http://localhost:3000). The stack starts PostgreSQL, persistent Redis, MinIO, and a one-shot MinIO bucket initializer; applies the Drizzle migrations; and runs the web, API, and BullMQ worker services.

Stop it with:

```bash
make down
```

To clear local signup, mailbox, workflow, queue and object-storage data without deleting schemas, migrations, buckets or Docker volumes, use:

```bash
make reset-local
```

The command stops application services, refuses non-local or unknown Docker configurations, restarts the normal stack and prints zero-state evidence. See [Reset local signup and mailbox data](./docs/local-development-reset.md) for its exact scope and safeguards.

## Run application processes outside Docker

Use the same root `.env.local`:

```bash
pnpm dev
```

The worker requires `REDIS_URL`. Start the Docker Redis service if Redis is not already running, then start the worker in a second terminal:

```bash
docker compose -f docker/compose.yml up -d redis
pnpm worker
```

## Database and migrations

Drizzle ORM accesses PostgreSQL through the server-only `DATABASE_URL`. PostgreSQL owns normalized product data, workflow/run state, Gmail applied and pending cursors, provider Batch correlation, and the transactional queue outbox. BullMQ uses `REDIS_URL` for execution state, retries, daily one-shot watch renewal, and stalled-job recovery. Raw MIME and attachment bytes use the S3-compatible endpoint configured by `S3_*`; Docker supplies MinIO. Authenticated attachment downloads read those stored bytes through the API without exposing object keys or public object URLs.

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
- Next.js contains UI only. It reaches the Fastify API through `/v1`; only the API and worker import database and Gmail packages.
- Product reads are scoped by user ID. Worker operations use explicit account, synchronization-run, and workflow-step IDs.
- Email content is treated as untrusted input in every model prompt.
- Gmail is canonical; provider label and Gmail Draft writes converge locally through Gmail history.
- Gmail and Invook labels/drafts share checked physical tables while retaining distinct provider-owned and local lifecycles.
- Inferred Memory requires evidence from at least three messages; global preferences additionally require evidence across at least three contacts.
- User-written memory wins over inferred memory.
- A user's applied or suppressed message-label decision wins over automatic label analysis.

## Project documents

- [Product requirements](./docs/product-requirements.md)
- [Gmail mailbox replica contract](./docs/gmail-replica-contract.md)

The project license has not been selected yet. Do not assume reuse rights until a license is added.
