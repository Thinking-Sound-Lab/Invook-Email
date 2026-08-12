# Invook product requirements

**Status:** Memory-first implementation  
**Updated:** August 11, 2026

## Product statement

Invook is an AI-native Gmail client that indexes a user's real mailbox, identifies what matters, and helps find, write, and eventually automate email work. AI is part of the product's operating model rather than a separate compose button.

The first differentiated loop is Memory-backed drafting:

1. Connect Gmail.
2. Index real mail and label the inbox.
3. Infer a small, inspectable Memory from full thread context and repeated owner-sent behavior.
4. Draft with only the memories that apply to the current conversation.
5. Treat the user's repeated draft corrections as high-quality feedback.
6. Let the user add, correct, or delete every memory.

There is no separate writing-profile or “voice” object. In Invook, personalization is the concrete, editable Memory used during drafting.

## Product principles

### Real data or an honest empty state

Invook never ships dummy mailbox, contact, memory, label, or draft data. If Gmail, indexing, or a model is unavailable, the interface explains the actual state.

### Opinionated defaults, user authority

Invook provides built-in Important, Travel, Pitch, and Newsletter labels. A user may add an account-owned label with an explicit description, which becomes the complete classification rule for a full indexed-mailbox scan. A user's thread-level label decision wins over later model runs.

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
- queue full-mailbox indexing without blocking the callback.

The first connection stores real normalized messages and thread metadata in PostgreSQL by following every Gmail result page, including Spam and Trash. After that one-time crawl, the mailbox Refresh action and account reconnects use the saved Gmail history cursor to apply message additions, deletions, and Gmail label changes. Only threads whose indexed content changed are relabeled, and only new eligible owner-sent evidence is considered for incremental Memory. An expired history cursor triggers a full snapshot reconciliation with change-aware upserts and deletion handling, so unchanged stored mail does not become new evidence or lose its labels.

### Mail workspace

The left sidebar contains:

- Compose, Search, Settings, Automations;
- All plus every built-in or user-created label owned by the connected account;
- mail views: Starred, Shared, Reminders, Scheduled, Drafts, Done, Sent, Trash.

The center pane shows Important mail first, then a divider, then the remaining mail. Selecting a thread replaces the list with the real thread.

The right pane is the future action agent for Find, Write, and Automate. It must not claim an action is available until its API and approval behavior exist.

### Label settings

Settings lists each label, its classification description, real analysis progress, and a delete control. Every label, including a built-in label, can be deleted. Deletion also removes that label's automatic and manual thread decisions and analysis history. Creating a label requires both a name and description. If native Batch is configured and Gmail indexing is complete, creation queues a durable PostgreSQL backfill job that checks every indexed thread. If Batch is unavailable, the label remains in an honest pending state.

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

Sending is outside the current slice. The UI must say **Save changes**, not imply that a message was sent.

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

Model classification may apply zero or more of:

- **Important:** timely attention, reply, decision, or meaningful consequence;
- **Travel:** bookings, itineraries, lodging, visas, check-in, or trip changes;
- **Pitch:** sales, recruiting, partnership, fundraising, sponsorship, or service proposals;
- **Newsletter:** recurring editorial, digest, product update, community update, or bulk marketing publication.

Every classification stores source, confidence, model ID, and analysis version. User-applied and user-dismissed states take precedence over AI.

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
  -> initial Gmail indexing, search indexing, and initial Memory
  -> PostgreSQL jobs for Gmail history sync, label backfills, and incremental Memory
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
- `threads`
- `messages`
- `labels`
- `thread_labels`
- `thread_label_analyses`
- `memory_entries`
- `memory_deletions`
- `memory_pending_evidence`
- `drafts`
- `message_attachments`
- `message_embeddings`
- `mail_sync_runs`
- `gmail_sync_pages`
- `gmail_sync_items`
- `workflow_steps`
- `queue_outbox`
- `audit_events`

BullMQ owns queue locks, retries, and stalled-job recovery in Redis. PostgreSQL workflow tables retain user-visible progress, page-level resumability, provider-Batch correlation, and reliable publication across the PostgreSQL/Redis boundary. New tables should be added only for a working feature and demonstrated query need.

## API requirements

Current mailbox, label, Memory, and draft endpoints include:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/mailbox` | Return the connected mailbox workspace |
| `POST` | `/v1/mailbox/sync` | Run a worker-backed Gmail history sync from the saved cursor and return after its database job completes |
| `POST` | `/v1/labels` | Create a label and queue its full indexed-mailbox backfill |
| `DELETE` | `/v1/labels/:labelId` | Delete any account-owned label and its decisions |
| `GET` | `/v1/memories` | Return the connected account's real Memory and status |
| `POST` | `/v1/memories` | Add a user-authored item |
| `PATCH` | `/v1/memories/:id` | Correct an item and make it user-authored |
| `DELETE` | `/v1/memories/:id` | Delete an item and retain only its fingerprint tombstone |
| `POST` | `/v1/threads/:id/drafts` | Generate a draft from the thread and applicable Memory |
| `PATCH` | `/v1/drafts/:id` | Save an edit and queue feedback analysis when changed |

Every mutation requires an authenticated signed session and an allowed request origin. IDs and bodies are validated before repository calls. User ownership is enforced in every product lookup.

## Initial non-goals

- Embedding-based Memory extraction or retrieval.
- A broad inferred relationship/personality graph.
- Automatic sending or autonomous mailbox mutations.
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

1. add conversational right-panel actions with explicit approvals and audit records;
2. add Gmail push-notification delivery so background sync does not depend on the current manual Refresh action or an account reconnect;
3. evaluate semantic retrieval for mailbox finding or factual context, independently of Memory extraction;
4. add sending, scheduling, reminders, and safe automations;
5. choose an open-source license and add contribution governance.
