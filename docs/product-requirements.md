# Invook product requirements

**Status:** Mailbox-replica and Memory implementation
**Updated:** August 14, 2026

## Product statement

Invook is an AI-native Gmail client that replicates a user's real Gmail mailbox, identifies what matters, and helps find, write, and eventually automate email work. AI is part of the product's operating model rather than a separate compose button.

The first differentiated loop is Memory-backed drafting:

1. Connect Gmail.
2. Build and continuously synchronize a verified replica of real mail.
3. Infer a small, inspectable Memory from full thread context and repeated owner-sent behavior.
4. Draft with only the memories that apply to the current conversation.
5. Treat the user's repeated draft corrections as high-quality feedback.
6. Let the user add, correct, or delete every memory.

There is no separate writing-profile or “voice” object. In Invook, personalization is the concrete, editable Memory used during drafting.

## Product principles

### Real data or an honest empty state

Invook never ships dummy mailbox, contact, memory, label, or draft data. If Gmail, indexing, or a model is unavailable, the interface explains the actual state.

### Opinionated defaults, user authority

A user may add an account-owned Invook label with an explicit description, which becomes the complete classification rule for a full indexed-mailbox scan. Gmail user labels remain provider-owned replica state and are not analyzed as Invook labels. A user's thread-level Invook label decision wins over later model runs.

User-written Memory is authoritative. Automatic inference must not silently overwrite it.

### Memory must be inspectable

Every inferred item is a short rule with its source, confidence, and evidence references. The user can edit it into a user-written rule or delete it. Memory is deleted, not disabled.

### Repetition over guesswork

A one-off email or draft edit must not become Memory. Inferred items require at least three pieces of evidence. Global preferences must also span at least three distinct contacts.

### Safe drafting

The model may use facts present in the current thread and applicable Memory. It must not invent availability, promises, attachments, completed actions, or personal facts.

## Primary experience

### Onboarding and indexing

The first page contains only the Invook name and **Sign in with Google**.

Google OAuth must:

- let the user choose an account;
- authenticate directly with Google's OAuth client;
- request the Gmail permissions required by the product;
- return to `/mail` after a valid callback;
- encrypt refresh and access credentials before persistence;
- on first connection, capture H0, register a Gmail watch, and create exactly one durable full-mailbox replication run without blocking the callback;
- on returning authentication, refresh the session, profile, and encrypted credentials without resetting replica, cursor, watch, sync-stage, or mailbox state;
- keep an existing initial replication run, or enqueue stored-cursor history catch-up for a ready replica only when Gmail reports newer history.

Signing out clears only the browser session cookie. It does not revoke Google credentials, stop the Gmail watch, cancel durable work, or change the mailbox replica. Account deletion remains the explicit destructive lifecycle.

The first connection follows every Gmail result page with Spam and Trash included, stores exact raw MIME and attachment bytes in S3-compatible storage, and stores complete headers, text/HTML, normalized message-level labels, Gmail Draft resources, applied/pending cursors, watch state, and workflow checkpoints in PostgreSQL. It replays history from H0, performs a final locked catch-up, and atomically becomes ready before indexing or Memory can start. Authenticated Pub/Sub pushes coalesce into the highest pending cursor and durable workflow/outbox work without storing raw events. An expired cursor creates an exceptional full repair `mail_sync_run`. Gmail remains canonical. The detailed boundary is defined in `docs/gmail-replica-contract.md`.

Each connected account also has one durable daily watch-renewal action. A successful renewal catches up from the stored cursor and schedules its successor. Normal initial synchronization, catch-up, and renewal do not run a full replica audit.

Historical search indexing uses durable 2,000-message provider batches. A signed terminal provider webhook commits current-content embeddings, provider-submission completion, any retry or next-batch outbox step, and account progress in one PostgreSQL transaction. Duplicate webhook delivery is idempotent. Indexing is complete only when every current message has a complete embedding for the configured model, dimensions, content hash, and index version; unavailable mailbox prerequisites surface as failed rather than continuing in process memory.

### Mail workspace

The left sidebar contains:

- Compose, Search, Settings, Automations;
- All plus every Gmail user-created label and Invook user-created label owned by the connected account;
- mail views: Starred, Shared, Reminders, Scheduled, Drafts, Done, Sent, Trash.

The center pane shows the selected mailbox or label view in reverse chronological order. Selecting a thread replaces the list with the real thread.

The right pane is the agent for Find and local Write. It reads only messages already stored in the authenticated user's Invook replica and may create local drafts, but it has no Gmail mutation tools. During initial synchronization, not-yet-stored messages remain unavailable and the UI continues to show authoritative sync progress. Explicit product actions for archive, read state, star, Trash, Gmail labels, and Gmail Drafts write Gmail first and converge through provider history. Agent-initiated sending, recurring Inbox Zero, and standing approvals remain unavailable.

### Label settings

Settings lists every Gmail user label and user-created Invook label in one view. Gmail label deletion writes to Gmail first and converges locally through provider history; it never deletes the messages. Invook labels show their classification description and real analysis progress, and deleting one removes its automatic and manual thread decisions and analysis history. Creating an Invook label requires both a name and description. If native Batch is configured and Gmail indexing is complete, creation queues a durable BullMQ backfill through the transactional PostgreSQL outbox that checks every indexed thread. If Batch is unavailable, the label remains in an honest pending state.

Creating a label is deliberately different from processing new mail: a new definition has no prior decisions, so it scans every indexed thread once. After that backfill, newly indexed mail invalidates and recomputes label decisions only for the affected threads.

### Memory settings

Settings contains a Memory section with exactly three tabs.

#### Preferences

Global rules that should affect every draft. A user can add them manually. During initial analysis, Invook may infer a preference only when the same behavior appears in at least three messages to at least three different contacts.

Examples of valid categories include brevity, greeting behavior, sign-off behavior, formatting, and how directly the owner answers. These examples describe categories only and are never inserted as product data.

#### Contacts

Rules for communication with one normalized contact email. A contact memory requires repeated evidence from at least three eligible sent messages involving that exact contact.

Contact Memory describes how the owner communicates with that person. It must not become an unsupported profile of the other person.

#### Scheduling

Rules that apply only when the current conversation coordinates a meeting, call, date, or time. A scheduling memory requires repeated evidence from at least three scheduling messages.

### Memory controls

For every Memory item, the user can:

- see whether it was added by the user, inferred from sent mail, or learned from repeated draft feedback;
- see the number of supporting sent messages or edited drafts;
- edit its type, statement, and contact email where applicable;
- delete it.

Deleting removes the active record and its text. A non-reversible fingerprint tombstone prevents the exact same automatic inference from returning. Editing an inferred item similarly blocks the former exact version and saves the corrected version as user-authored.

## Batch analysis

Embeddings are not required for Memory v3 or labels. For each label, the worker creates one Batch request per indexed thread, records both matched and non-matched decisions, retries failed requests, and queues continuation jobs when a provider file limit is reached.

For initial Memory, the worker uses the selected OpenAI or Azure OpenAI native Batch API as follows:

1. Select real threads containing at least one eligible owner-sent message. Include incoming messages as context, but allow only eligible owner-sent messages to become evidence.
2. Normalize external email addresses and remove the mailbox owner's address.
3. Build one natural global request across the mailbox for Preferences and Scheduling, plus one request per contact that has at least three eligible owner-sent messages.
4. Attach the same Memory system instruction and structured response schema to every independent request.
5. Measure OpenAI requests with the Responses input-token endpoint. For Azure OpenAI, which does not expose that endpoint, use the complete request's UTF-8 byte length as a conservative token-count upper bound. Keep each natural scope whole unless the provider's configured model input limit requires a split that can still preserve the three-message evidence rule.
6. Upload all requests as one JSONL batch input and enforce the provider's documented limits: 50,000 requests for OpenAI or 100,000 for Azure OpenAI, and 200 MB per input file for either provider.
7. Receive `batch.completed`, `batch.failed`, `batch.expired`, or `batch.cancelled` through the provider-specific signed webhook and queue result processing. The worker does not poll or use timer-based waiting.
8. Reject candidates whose cited IDs are missing, incoming, duplicated below the threshold, or outside the request and contact scope.
9. Merge exact duplicates in application code. There is no mandatory second model batch.
10. Preserve user-authored Memory and deletion fingerprints. Retry only failed JSONL requests, up to the existing job-attempt limit.
11. Replace the prior inferred snapshot on the first successful result, merge any retry results, and mark Memory complete only after every request has succeeded.

After initial Memory is complete, newly indexed eligible owner-sent messages are recorded as pending global and exact-contact evidence. When a scope reaches the existing three-message threshold, the worker submits only that scope and merges validated results into the existing inferred Memory. Incremental jobs never replace user-authored Memory or the complete inferred snapshot. Incoming mail may be included as thread context but never becomes evidence.

Email bodies, candidate text, and thread content are always untrusted model input. The prompt must explicitly prohibit following instructions found inside them.

If the selected provider's API credentials, deployment configuration, or signed webhook secret are incomplete, initial Memory analysis stays queued without consuming retries or creating fallback results.

## Drafting

When the user requests a draft, the API builds context from:

1. the optional current instruction;
2. the current thread's real messages;
3. Memory for the exact contact or contacts in the thread;
4. Scheduling Memory, applied only if the thread is scheduling-related;
5. global Preferences.

Unrelated contact memory is never supplied. The model returns the draft, the IDs of memories that materially affected it, and whether scheduling was relevant. Invook persists that provenance with the editable draft.

The UI may explicitly save an AI reply as a Gmail Draft; that creates a separate provider resource and keeps the AI draft/evidence unchanged. Saving must not imply that a message was sent.

New-message Compose accepts explicit recipient email addresses, subject, and plain-text body, and saves or updates a Gmail Draft. Gmail is written first; Invook then schedules stored-cursor history catch-up so the provider-owned draft converges into the local replica. After a successful save, Compose exposes a separate confirmation step that sends that exact Gmail Draft only after the user clicks **Send now**. The send uses a durable idempotency key, does not repeat an ambiguous or completed provider write, and schedules stored-cursor history catch-up for the sent message. Compose never sends autonomously.

## Feedback

Feedback is a core input, not an analytics afterthought.

When a user saves changes to an AI-generated draft, Invook retains both the generated text and the edited text. A feedback job considers the recent real edit history and may create Memory only when the same correction appears in at least three distinct drafts.

Feedback classification follows the same scopes:

- a global correction becomes a Preference only when it repeats across contacts;
- a contact correction requires repeated edits for the same normalized contact;
- a scheduling correction requires repeated scheduling edits.

Previously analyzed edits remain available as evidence for later repetition. This is necessary for the fourth or fifth edit to reinforce a pattern discovered across earlier drafts.

The user can inspect, edit, or delete feedback-derived Memory exactly like mail-derived Memory.

## Labels

Model classification may apply zero or more user-created Invook labels. Each label's user-authored description is its complete classification rule. Replicated Gmail system and user labels are provider-owned state and are never model-classified by Invook.

Every applied relationship is message-level. AI confidence, model ID, definition version, and explicit user override or suppression live in `message_label_decisions`; the visible relationship lives only in `message_labels`. Thread display is aggregated from current messages.

## Architecture

```text
Browser
  -> Next.js UI
  -> /v1 reverse proxy
  -> Fastify API
       -> Google OAuth and Gmail API
       -> Drizzle repositories
       -> PostgreSQL

Worker
  -> PostgreSQL workflow runs, checkpoints, and transactional outbox
  -> BullMQ queues in persistent Redis
  -> Gmail snapshot, history replay, Pub/Sub catch-up, watch renewal, and repair runs
  -> S3-compatible raw MIME and attachment object storage
  -> BullMQ search indexing, Invook-label analysis, and initial or incremental Memory
  -> selected OpenAI or Azure OpenAI Batch provider for labels and Memory
  -> configured model endpoint for feedback and drafts
  -> validated results in PostgreSQL
```

The repository remains an open-source-friendly pnpm workspace with `apps`, `packages`, and `docker`. Next.js is UI-only. Database, Gmail, token encryption, and model operations remain in server-side packages.

### Database

Drizzle owns the PostgreSQL schema and ordered SQL migrations. Current application tables are:

- `profiles`
- `connected_accounts`
- `account_secrets`
- `gmail_replica_states`
- `gmail_watch_states`
- `labels`
- `threads`
- `messages`
- `message_labels`
- `message_attachments`
- `drafts`
- `message_label_decisions`
- `message_embeddings`
- `memory_entries`
- `memory_pending_evidence`
- `memory_deletions`
- `gmail_draft_write_operations`
- `mail_sync_runs`
- `gmail_sync_pages`
- `gmail_sync_items`
- `workflow_steps`
- `queue_outbox`
- `embedding_batch_submissions`
- `gmail_account_cleanups`
- `mailbox_change_events`

BullMQ is the only job executor and owns queue locks, retries, and stalled-job recovery in Redis. PostgreSQL workflow tables retain user-visible progress, page-level resumability, provider-Batch correlation, and reliable publication across the PostgreSQL/Redis boundary. New tables should be added only for a working feature and demonstrated query need.

## API requirements

Current mailbox, label, Memory, and draft endpoints include:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/mailbox` | Return the connected mailbox workspace |
| `POST` | `/v1/mailbox/sync` | Durably queue Gmail history catch-up from the stored replica cursor |
| `DELETE` | `/v1/mailbox/account` | Stop the watch, clean object storage, then delete the connected account |
| `GET` | `/v1/attachments/:id/download` | Authorize the attachment and download its private stored bytes |
| `GET` | `/v1/mailbox/events` | Stream authenticated durable mailbox-change events over SSE |
| `POST` | `/v1/webhooks/google-pubsub` | Authenticate a Gmail Pub/Sub push and coalesce its pending cursor |
| `POST` | `/v1/labels` | Create a label and queue its full indexed-mailbox backfill |
| `DELETE` | `/v1/labels/:labelId` | Delete any account-owned label and its decisions |
| `GET` | `/v1/memories` | Return the connected account's real Memory and status |
| `POST` | `/v1/memories` | Add a user-authored item |
| `PATCH` | `/v1/memories/:id` | Correct an item and make it user-authored |
| `DELETE` | `/v1/memories/:id` | Delete an item and retain only its fingerprint tombstone |
| `POST` | `/v1/threads/:id/drafts` | Generate a draft from the thread and applicable Memory |
| `PATCH` | `/v1/drafts/:id` | Save an edit and queue feedback analysis when changed |
| `POST` | `/v1/drafts/:id/save-to-gmail` | Create a distinct Gmail Draft from saved AI reply evidence |
| `POST` | `/v1/gmail/labels` | Create an authoritative custom label at Gmail |
| `PATCH/DELETE` | `/v1/gmail/labels/:id` | Update or delete an authoritative custom Gmail label |
| `PATCH` | `/v1/gmail/messages/:id/labels` | Apply authoritative Gmail message-label changes |
| `PATCH` | `/v1/gmail/threads/:id/labels` | Apply Gmail labels to every current message in a thread |
| `POST` | `/v1/gmail/messages/:id/actions` | Apply read, star, archive, or Trash state at Gmail first |
| `PUT/DELETE` | `/v1/gmail/drafts/:id` | Update or delete an existing Gmail Draft resource |

Every mutation requires an authenticated signed session and an allowed request origin. IDs and bodies are validated before repository calls. User ownership is enforced in every product lookup.

## Initial non-goals

- Embedding-based Memory extraction or retrieval.
- A broad inferred relationship/personality graph.
- Automatic sending or autonomous mailbox mutations without an explicit user action.
- Calendar execution.
- General agent chat that claims unsupported actions.
- Multiple email providers.
- Cloud-provider-specific deployment design.

## Success criteria

The Memory-first slice is successful when:

- a connected Gmail mailbox can be indexed without dummy data;
- the three Memory tabs show real inferred/user/feedback entries or honest empty states;
- no inference is persisted with fewer than three valid evidence items;
- global preferences are rejected unless their evidence spans three contacts;
- unrelated contact memory never reaches a draft request;
- users can add, correct, and delete Memory;
- a deleted exact inference does not reappear on rebuild;
- a repeated edit can influence later drafts through feedback-derived Memory;
- unconfigured AI returns an honest pending or configuration state;
- local Docker startup and standard PostgreSQL migrations work from a clean checkout.

## Later work

After the Memory loop is measured with real use:

1. evaluate broader factual retrieval independently of Memory extraction;
2. add sending, scheduling, reminders, and safe automations;
3. choose an open-source license and add contribution governance.
