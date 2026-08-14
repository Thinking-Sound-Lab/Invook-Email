# Gmail mailbox replica contract

**Status:** Implemented contract
**Canonical provider:** Gmail
**Updated:** August 14, 2026

## Scope and ownership

For each connected Gmail account, Invook continuously replicates every message returned with Spam and Trash included, the Gmail label catalog and message-level memberships, Gmail Draft resources, complete parsed message metadata, exact raw MIME, and decoded attachment bytes.

Gmail is canonical for Gmail-backed labels, read/unread, star, Inbox/archive, Trash, messages, and Gmail Draft resources. Invook writes provider-owned state to Gmail first and lets Gmail history converge PostgreSQL. It never creates an optimistic competing provider state.

The shared `labels` table distinguishes Gmail-backed and Invook-only labels with a checked discriminator. The shared `message_labels` table is the only visible applied-label relationship. Thread labels are calculated from current message memberships; applying a Gmail label from a thread operation affects the thread's current messages and does not establish inheritance for future mail. `message_label_decisions` stores AI decision metadata and explicit user override or suppression, never a second visible relationship.

The shared `drafts` table distinguishes Gmail resources from local Invook drafts. A Gmail draft retains provider identifiers and metadata. A local draft retains editable text, model provenance, feedback, and Memory evidence without becoming a Gmail resource until the user explicitly promotes it. `gmail_draft_write_operations` is the idempotency and ambiguous-result ledger for Gmail draft create, update, and send operations.

PostgreSQL stores normalized replica state, durable runs, workflow steps, and the transactional queue outbox. S3-compatible object storage owns raw MIME and attachment bytes. BullMQ and Redis execute and retry work but are not the durable source of work.

## Initial synchronization

An account is unavailable to indexing, Memory, and AI-label workflows until this watch-first sequence completes:

1. Complete Gmail OAuth and capture history cursor H0.
2. Register and persist the Gmail watch immediately.
3. Create one durable initial `mail_sync_run`.
4. Snapshot the Gmail label catalog and discover all message IDs, including Spam and Trash.
5. Process each message in its own idempotent workflow job. Message concurrency is configured by `GMAIL_MESSAGE_CONCURRENCY` and defaults to five.
6. Upload raw MIME and attachment bytes and persist relational message state.
7. Synchronize Gmail Draft resources.
8. Under the account advisory lock, replay history from H0 and continue while a newer pending notification cursor exists.
9. Atomically mark the replica ready at the final applied cursor.
10. Only then publish embedding, Memory, and Invook-label derivation work.

A successful normal synchronization does not run a separate full-replica audit.

## Pub/Sub admission

Google Pub/Sub sends OIDC-authenticated pushes to `/v1/webhooks/google-pubsub`. The API validates the audience, service-account identity, exact subscription, envelope, email address, and decimal history ID.

For a matching connected account, one PostgreSQL transaction locks replica state, retains only the highest pending history cursor, and creates an idempotent `gmail.history.catchup` workflow step plus queue-outbox record. Duplicate and reordered notifications coalesce through the pending cursor and workflow idempotency key. The raw Pub/Sub payload, message ID, email address, and delivery event are not persisted. The route returns `204` without calling Gmail inline. Notifications received during initial synchronization remain pending and are replayed before or immediately after readiness.

## Incremental catch-up

Gmail control work is serialized per account with a PostgreSQL advisory lock. A catch-up rereads the committed history cursor, applies one provider-history range, advances the cursor in the same transaction as replica changes, and clears pending state only when the applied cursor reaches it. If a higher notification cursor remains, the worker creates a distinct durable continuation step and yields the account lock; the next control job continues from the new committed cursor.

History work is operation-specific:

- A new or content-changed message downloads raw MIME once, parses it, stores objects, and upserts relational state.
- A label-only change updates `message_labels` from minimal Gmail message state without downloading MIME.
- An unknown provider label fetches only that label and retries the membership update.
- A deletion creates a durable `gmail.objects.delete` workflow step containing an immutable provider/object-key manifest before deleting relational state.
- A draft-related change lists draft references and refreshes or removes only the affected Gmail Draft resource.
- A mailbox change event is emitted only after the corresponding transaction commits.

Duplicate execution is safe through provider identifiers, expected-cursor checks, unique constraints, workflow idempotency keys, and transactional outbox publication. A crashed worker retries from durable state.

## Watch renewal and repair

Watch renewal is a durable daily one-shot action. It persists the renewed watch, schedules its successor, and performs stored-cursor catch-up as a safety net. It does not poll or run a routine full-mailbox audit.

If Gmail rejects an expired history cursor, Invook captures a fresh provider baseline, renews the watch, and creates an exceptional repair-type `mail_sync_run`. Repair uses the same paged discovery and per-message jobs as initial synchronization, then replays from the fresh baseline under the account lock before returning to ready. A reconnect-required account follows the same durable repair-run path after successful OAuth.

Permanent credential rejection atomically marks the account `reconnect_required`, fails active Gmail work, and prevents already-published jobs from reactivating terminal state. Transient provider and transport failures retain bounded workflow retries.

## Provider writes

Explicit user actions for read/unread, star, archive, Trash, Gmail-backed labels, and Gmail Draft edits call Gmail first. After a confirmed provider response they enqueue stored-cursor catch-up. Local Gmail-backed state changes only when history is applied.

Creating a local Invook draft does not create a Gmail draft. Explicit promotion, Gmail Draft editing, and sending retain provider-write idempotency and ambiguous-result evidence in `gmail_draft_write_operations`. AI evidence remains separate after promotion.

## Deletion

Message deletion durably records object cleanup before relational deletion. The cleanup manifest survives worker crashes and no tombstone table is required.

Account deletion enters a durable deleting state. Its cleanup workflow stops the Gmail watch when possible, deletes every recorded raw-MIME and attachment object, and only then deletes the relational account. Transient provider or object-storage failures retry without losing `gmail_account_cleanups` state.

## External configuration

Continuous delivery requires:

- a Pub/Sub topic named by `GMAIL_PUBSUB_TOPIC`, with Gmail allowed to publish;
- an authenticated push subscription targeting `/v1/webhooks/google-pubsub`;
- `GOOGLE_PUBSUB_PUSH_AUDIENCE` matching the OIDC audience;
- `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL` matching the subscription service account;
- `GOOGLE_PUBSUB_SUBSCRIPTION` matching the full subscription resource name.

Without these resources, Gmail connection and continuous synchronization remain honestly unavailable.
