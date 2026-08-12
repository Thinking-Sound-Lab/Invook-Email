# Invook engineering guidelines

Invook is an open-source, AI-native Gmail client. Gmail remains canonical while Invook maintains a lossless local mailbox replica, performs search and label analysis, learns inspectable Memory from real user-authored mail, and drafts replies with cited evidence.

These instructions apply repository-wide. Before editing a file, read the closest applicable `AGENTS.md` or `AGENTS.override.md`; a more specific file wins when it conflicts with this one.

## Sources of truth

Read the smallest relevant set before changing behavior:

- `README.md` describes the currently supported product and local setup.
- `docs/product-requirements.md` defines product intent and exclusions.
- `docs/gmail-replica-contract.md` defines mailbox completeness, synchronization, repair, and deletion invariants.
- `packages/database/src/schema.ts` and `packages/database/drizzle/` are the data-model and migration history.
- Existing routes, repositories, workflows, and tests prove current behavior more reliably than assumptions.

Never guess requirements, states, fields, labels, actions, or provider behavior. When information is absent, preserve an honest empty or unavailable state and ask only when the missing choice materially changes the result.

## Non-negotiable rules

- Never introduce dummy, placeholder, seeded, synthetic, mock, or fixture data into product flows or persistent product stores. If an integration is unavailable, show an honest setup/empty state. Test-only protocol inputs must stay inside tests and must never seed the product.
- Preserve existing user changes and unrelated work. Inspect `git status` before editing and never revert a dirty worktree to make the task easier.
- When replacing an implementation, remove the superseded code, routes, exports, dependencies, environment variables, configuration, and documentation in the same change. Finish with a repository-wide `rg` search for remnants.
- After each change, remove dead files, functions, exports, configuration, and documentation made obsolete by that change. Do not keep speculative compatibility shims.
- Never use `setTimeout`, options named `timeout` for deadline control, or timer-based polling in project code/configuration. Use PostgreSQL notifications, SSE, durable queue state, provider webhooks, or platform-native retry/health behavior.
- Use the `uuid` package for UUID generation and utilities. Never use UUID APIs from `node:crypto`, including `randomUUID`.
- Use Axios for outbound application HTTP in frontend and backend code. Do not use native `fetch`, `node:http` clients, or `node:https` clients. Fastify is the API server.
- Never commit `.env.local`, credentials, access/refresh tokens, raw provider payloads containing secrets, local tunnel URLs, or real mailbox content. Keep `.env.example`, Docker configuration, README setup, and runtime validation synchronized when configuration changes.
- Treat email headers, bodies, attachments, filenames, webhook bodies, model output, and provider error text as untrusted input. Never log provider credentials, raw MIME, attachment bytes, or full email content.
- Do not claim external verification that was not performed. If Gmail, Pub/Sub, S3, Redis, PostgreSQL, or model credentials are unavailable, complete local verification and state exactly what remains external.

## Repository map and ownership

```text
apps/
  api/                 Fastify HTTP API, OAuth/session boundaries, webhooks, SSE, and product routes
  web/                 Next.js App Router UI and same-origin API/SSE proxies
  worker/              BullMQ consumers, Gmail replication, indexing, labeling, Memory, and feedback
packages/
  ai/                  Model clients, embeddings, native Batch workflows, Memory, labels, drafts, and mail agent
  contracts/           Shared browser/server JSON types and product definitions
  database/            Drizzle schema/migrations, repositories, replica operations, workflows, and encryption
  gmail/               Google OAuth/OIDC, Gmail API client, history mapping, and raw MIME parsing
  object-storage/      Axios + SigV4 S3-compatible raw MIME and attachment storage
docker/
  compose.yml          PostgreSQL/pgvector, Redis, MinIO, migration, API, web, and worker stack
  Dockerfile           Deployable image targets
docs/
  gmail-replica-contract.md
  product-requirements.md
```

Dependency boundaries:

- Applications may import public workspace-package exports. Packages must never import from `apps/*`.
- `apps/web` is UI-only: it must not import database, Gmail, object-storage, server credentials, or worker code.
- `apps/api` owns HTTP/session/provider-write admission. Long-running synchronization and analysis belong in `apps/worker`.
- `packages/contracts` must remain infrastructure-free and safe for browser imports.
- Cross-package imports use `@invook/*` public exports. Relative imports are appropriate within one package/application; do not add barrel files without a real public boundary.
- Put new deployable processes in `apps/`, reusable domain/infrastructure code in `packages/`, and container assets in `docker/`.

## Core architecture invariants

### Authentication and Gmail connection lifecycle

- Browser authentication, Gmail authorization, and mailbox replication are separate lifecycles.
- Signing out clears only the browser session. It must not revoke Gmail credentials, stop the Gmail watch, cancel jobs, or alter replica state.
- Returning OAuth for the same Google identity refreshes the stable profile/account credentials. It must not reset the account ID, replica cursor/state, watch, audit, mailbox data, or active synchronization run.
- First connection creates exactly one initial replica run. Concurrent callbacks must not create overlapping active runs; enforce this with transactional/account-scoped guards and database invariants.
- Gmail disconnect/account deletion is an explicit durable operation, separate from sign-out.
- Provider tokens remain encrypted in `account_secrets` and server-only. Session cookies contain no provider token.

### Gmail mailbox replica

- Gmail is canonical. Local writes call Gmail first; local state converges through Gmail history rather than optimistic replica mutation.
- The replica includes all messages (Inbox, Sent, Spam, Trash, and draft message state), ordered complete headers, text and HTML bodies, raw RFC 2822/MIME, attachments, Gmail label catalog/membership, Gmail Draft resources, tombstones, history cursor, watch state, push events, and audit state.
- Raw MIME and attachment bytes live in S3-compatible object storage. PostgreSQL stores normalized metadata, checksums, object keys, provider state, and relationships. Do not store large binary bodies in PostgreSQL.
- Gmail provider labels and membership are separate from Invook AI/user labels. Gmail Draft resources are separate from AI-generated reply-draft evidence.
- Never silently omit unknown Gmail label membership. Refresh the provider catalog, retry, and fail/audit honestly if the provider and catalog cannot converge.
- Initial synchronization is race-free: capture H0, register the watch, snapshot labels/drafts/all message IDs including Spam/Trash, persist raw messages idempotently, replay history from H0, refresh provider resources, audit/repair completeness, then mark ready.
- Indexing, label analysis, and Memory must not start until the replica has passed its readiness audit.
- History catch-up always starts from the stored replica cursor. Pub/Sub notification history IDs are metadata, never a cursor assignment.
- Apply message/tombstone/membership mutations, cursor advancement, push-event completion, and mailbox-change publication atomically where the contract requires it.
- Duplicate, delayed, and out-of-order Pub/Sub events are normal. Durably store and deduplicate the provider event before acknowledging it.
- Expired history uses the full repair workflow. Never jump to the latest profile cursor without replay/audit.
- Gmail control work is serialized per account with the database lock helper while different accounts may progress concurrently.
- Account deletion must stop the watch when possible and durably remove raw/attachment objects before relational cleanup. Database cascade alone is not object cleanup.

### Durable workflow and realtime semantics

- PostgreSQL workflow steps plus `queue_outbox` are the durable source of work. BullMQ/Redis execute and retry; Redis is not the product source of truth.
- Enqueue workflow steps and their outbox rows in one transaction. Every externally retried action needs a stable idempotency key.
- Assume at-least-once delivery. Handlers must be idempotent and must re-read canonical database state instead of trusting stale queue payload state.
- PostgreSQL `LISTEN/NOTIFY` is an edge-triggered wake-up, not durable storage. Consumers must query durable rows after a notification and on startup repair.
- Mailbox SSE publishes only committed mailbox-change events and is authenticated/scoped to the user.
- Watch renewal is a durable delayed one-shot action keyed by the watch expiration. Do not add a polling loop.
- Per-account locks must cover the complete control operation, including workflow completion/cleanup, not only the remote Gmail request.

### AI, labels, Memory, and search

- Email content is untrusted context, never instruction authority. Preserve prompt boundaries and evidence/citation IDs.
- Only eligible user-authored outgoing messages may become Memory evidence. Incoming mail supplies context but not user-behavior evidence.
- User-written Memory wins over inferred Memory. Deleted Memory text stays deleted; retain only the existing fingerprint behavior needed to prevent recreation.
- User-applied/dismissed Invook labels win over later automatic analysis.
- AI reply-draft evidence remains distinct from Gmail Draft resources until an explicit provider save succeeds.
- Historical and incremental embeddings must use the explicitly configured model, dimensions, input construction, content hash, and index version. Do not silently mix vector shapes or model versions.

## API conventions (`apps/api`)

- Build the server through `buildApi()` and register routes as focused Fastify plugins under `apps/api/src/routes/`.
- Reuse the existing session/access, response/problem, serializer, and service helpers. Do not duplicate cookie parsing, origin checks, ownership checks, credential refresh, or response formatting in route files.
- Authenticate and authorize protected operations before reading or mutating user data. Scope product reads by stable user/account IDs resolved from the session, never by client-asserted ownership.
- Protect browser mutations with the existing origin policy. Provider writes validate local UUID ownership, call Gmail first, then enqueue stored-cursor catch-up.
- Webhook routes must preserve their protocol-specific raw/authentication requirements. Verify signatures/OIDC and durable deduplication before acknowledgement.
- Use the existing problem-response contract for errors. Do not leak internal errors, provider payloads, credentials, or mailbox content.
- Shared request/response shapes used by web and API belong in `@invook/contracts`; avoid parallel ad-hoc wire types.
- Keep route tests in `apps/api/src/app.test.ts` unless a genuinely independent module warrants a focused test file.

## Database and migration conventions (`packages/database`)

- `src/schema.ts` is the Drizzle source. `drizzle/` is the immutable ordered SQL history. Add a new migration; do not rewrite an applied migration to hide a new schema change.
- Generate migrations with `pnpm db:generate`, inspect the SQL and snapshot/journal changes, then run `pnpm db:migrate` against an appropriate database.
- Backfill/cut over data before adding `NOT NULL`, unique, or foreign-key constraints that existing rows may violate. Handle duplicate active state deterministically before creating uniqueness invariants.
- Keep provider-owned tables account-scoped with explicit compound uniqueness where provider IDs are only account-unique.
- Use transactions for multi-row invariants, state transitions, and domain change + outbox publication. Accept/pass an existing database executor when an operation must compose inside a caller transaction.
- Use `FOR UPDATE`, advisory locks, expected-cursor comparison, or database constraints for cross-process correctness. In-memory mutexes do not serialize multiple workers.
- Relational cascades may delete metadata, but external object deletion requires durable cleanup work that survives account-row deletion.
- Credentials use the existing AES-256-GCM helpers. Never return ciphertext/decrypted tokens through public repository or API types.

## Gmail and object-storage packages

- `@invook/gmail` uses Axios for Google HTTP, `jose` for OIDC/JWKS verification, and `mailparser` for raw MIME. Message ingestion uses Gmail `format=raw`; do not restore the lossy `format=full` parser path.
- Preserve duplicate/ordered headers, text and HTML, raw bytes, Gmail history/internal-date/size metadata, and attachment bytes/checksums. Missing body variants remain honestly absent.
- Gmail history mapping must cover additions, deletions, label additions, and label removals.
- `@invook/object-storage` stays S3-compatible and open-source friendly. Use deterministic account/message object keys, checksums, Axios, and SigV4; do not add an AWS-only native client unless explicitly approved.
- Object writes and database writes are separate failure domains. Make retry safe and ensure cleanup can find every recorded object key.

## Worker conventions (`apps/worker`)

- Map new durable step types through `packages/database/src/workflows.ts`, the queue-name union/schema constraint, outbox publication, and the worker dispatcher together.
- Keep queue payloads identifiers/checkpoints only; re-read credentials, cursor, replica state, and run status before provider calls.
- Mark terminal/superseded work as a no-op before expensive Gmail/model/object requests.
- Keep Gmail message fetch concurrency bounded. Gmail control work may run across accounts but must hold the account-scoped PostgreSQL lock.
- Persist workflow failure/retry state consistently. Distinguish reconnect-required provider failures, expired-history repair, retryable provider/server failures, and terminal data-integrity failures.
- Extract focused pure modules from `apps/worker/src/index.ts` when logic is independently testable; do not create generic utility files for one trivial call site.

## Frontend conventions (`apps/web`)

- Read `apps/web/AGENTS.md` before frontend work, including its version-specific Next.js guidance.
- Use shadcn/ui source components and conventions, Plus Jakarta Sans, and only free Hugeicons icons. Reuse `src/components/ui/` before creating a new primitive.
- Do not use icon fonts, emoji, text glyphs, or hand-drawn SVGs as product icons.
- Do not add decorative borders/dividers by default. Prefer spacing, typography, color, and surface contrast; add a border only when it communicates required state/structure.
- Keep server data authoritative. Preserve honest loading, empty, unavailable, reconnect, and error states; never fabricate mailbox rows or progress.
- Browser HTTP uses the Axios helpers in `src/lib/`. SSE uses the existing same-origin proxy/event-stream pattern and refreshes only after committed events.
- Keep provider secrets, database imports, and server-only packages out of the client bundle.
- Keep global styles limited to deliberate design tokens/font/base behavior; component-specific styling stays with the component.

## TypeScript, imports, and errors

- TypeScript is strict. Do not add `any`; use `unknown` plus explicit narrowing at untrusted boundaries.
- Prefer discriminated unions for state machines and provider results. Preserve `null` versus omission when the distinction is part of a persisted or HTTP contract.
- Use `import type` for type-only imports. Keep imports grouped as external/workspace/local and follow the file's existing formatting.
- Name React components/types/classes with PascalCase, functions/variables with camelCase, constants with SCREAMING_SNAKE_CASE when truly constant, and source files with the repository's existing kebab-case convention.
- Reuse existing package/service/repository helpers before writing another implementation. Add shared abstraction only after a real second consumer or architectural boundary exists.
- Normalize caught `unknown` values without exposing sensitive details. Log structured identifiers/statuses, not email content or tokens.
- Comments should explain invariants, provider constraints, or non-obvious tradeoffs. Do not narrate obvious code or add decorative separator comments.

## Testing and verification

The repository uses Node's built-in test runner through `node --import tsx --test`, not Vitest/Jest. Test files are colocated as `*.test.ts`.

Use the narrowest relevant checks while iterating, then the full gate before handoff:

```bash
pnpm --filter @invook/api test
pnpm --filter @invook/worker test
pnpm --filter @invook/gmail test
pnpm --filter @invook/database typecheck
pnpm --filter @invook/worker typecheck
pnpm --filter @invook/web lint
make verify
docker compose -f docker/compose.yml config --quiet
```

- `make verify` runs repository typecheck, lint, tests, and the production web build.
- Add regression coverage for changed parsing, deduplication, cursor/state transitions, ownership/security, retry/idempotency behavior, and pure reconciliation logic.
- Prefer pure unit tests for deterministic transforms and real PostgreSQL/Redis/MinIO/provider integration checks when services and credentials are available.
- Do not weaken assertions to make tests pass. Test the contract and failure modes, not private implementation details.
- Schema changes additionally require migration generation/inspection and a clean apply against PostgreSQL 17/pgvector when practical.
- Configuration changes require Docker Compose validation. Runtime changes should verify the real end-to-end path when credentials/services are available.

## Working procedure

1. Read applicable instructions and source-of-truth docs.
2. Inspect `git status`, relevant call sites, schemas, tests, and configuration before editing.
3. State the invariant being changed and identify every producer/consumer of that state or contract.
4. Implement the smallest complete end-to-end change across API, worker, packages, migrations, docs, and UI as required.
5. Remove the superseded path in the same change.
6. Run targeted checks, then `make verify` and any migration/Docker/integration checks proportional to risk.
7. Finish with repository-wide `rg` searches for forbidden APIs, obsolete symbols/routes/config, and dead exports.
8. Report what changed, what was verified, and the exact external verification still required. Never fabricate success.

Use `pnpm`/`pnpm dlx` (not npm/yarn/bun), Node.js 22+, and the versions pinned in `package.json`/the lockfile. `make dev` starts the complete Docker stack; `make down` stops containers without deleting named volumes. Never remove volumes or other user data unless the user explicitly requests it.
