# Gmail mailbox replica contract

**Status:** Implemented contract
**Canonical provider:** Gmail
**Updated:** August 12, 2026

## Scope

For each connected Gmail account, Invook maintains a continuously convergent local replica of:

- every Gmail message returned with Spam and Trash included, including Inbox, Sent, Spam, Trash, and Draft state;
- Gmail system and custom label catalog entries and normalized message-label membership;
- the complete ordered message headers, decoded text body, decoded HTML body, Gmail history ID, internal date, size estimate, and snippet;
- the exact RFC 2822/MIME source and every decoded attachment byte stream, with SHA-256 checksums and object metadata;
- Gmail Draft resources, kept separate from Invook AI reply-draft evidence;
- Gmail message deletions as tombstones, including the last provider identifiers and retained object keys;
- the authoritative applied Gmail history cursor, watch topic/expiration/lifecycle state, deduplicated Pub/Sub deliveries, and replica audit results.

Gmail settings, contacts, and calendar are not part of this phase.

## Ownership boundaries

Gmail is canonical. Provider writes go to Gmail first and local state changes only after Gmail history is applied. Notification history IDs are stored as delivery metadata and never advance the replica cursor.

`gmail_labels`, `gmail_message_labels`, and `gmail_drafts` are provider-owned data. Invook's `labels` and `thread_labels` remain AI/user classification data. Invook's `drafts` table remains AI reply text, provenance, and feedback evidence. Saving an AI reply to Gmail creates a distinct Gmail Draft resource and does not convert or erase the AI evidence.

PostgreSQL stores normalized metadata, lifecycle state, tombstones, workflow checkpoints, audit results, and the transactional queue outbox. Raw MIME and attachment bytes live in the configured S3-compatible object store. The local Docker stack uses MinIO, while the application accesses it through the same Axios and SigV4 package used for any compatible hosted service.

## Initial synchronization

An account is not readable by indexing or Memory workflows until all of these steps succeed:

1. Capture Gmail history cursor H0.
2. Register the Gmail watch and persist its expiration.
3. Snapshot the current Gmail label catalog and all message IDs with Spam and Trash included.
4. Fetch each message as raw MIME, parse it without stripping content, upload raw/attachment objects, and persist it idempotently.
5. Replay Gmail history from H0 through the provider's current cursor. Message changes and cursor advancement commit together.
6. Refresh Gmail labels and Gmail Draft resources.
7. Audit provider/local message IDs, provider label and draft catalogs, and every current raw/attachment object checksum; repair recoverable differences.
8. Mark the replica ready, then enqueue search indexing and Memory extraction.

There is no finalization path that jumps directly to the latest profile cursor.

## Continuous synchronization

Google Pub/Sub sends authenticated OIDC push requests to `/v1/webhooks/google-pubsub`. The API validates the token audience, verified service-account email, and exact subscription. It commits the unique Pub/Sub message ID and a catch-up workflow step before returning `204`.

The worker serializes Gmail control work per account with a PostgreSQL advisory lock while allowing different accounts to progress concurrently, and always rereads the stored replica cursor. Duplicate and out-of-order deliveries are safe because history application uses an expected-cursor comparison and idempotent provider identifiers. Message/tombstone/label membership changes, cursor advancement, push-event completion, and the durable mailbox-change event commit in one PostgreSQL transaction. The web client listens to authenticated `/v1/mailbox/events` SSE and refreshes on committed mailbox changes.

Watch renewal is a delayed, durable one-shot BullMQ action keyed by the watch expiration. It registers the replacement watch, catches up history, audits completeness, and schedules only the next renewal. It does not poll.

## Repair and deletion

Initial completion, expired-history recovery, watch renewal, and manual audit use the same completeness and repair rules. Audits compare Gmail's current label membership for every message with normalized local membership and refetch mismatches before readiness. If Gmail rejects an expired history cursor, Invook captures a fresh baseline, renews the watch, reconciles a full snapshot, replays from that baseline, refreshes labels/drafts, and audits before returning to ready.

Account deletion first enters a durable deleting state. The cleanup action stops the Gmail watch when the credential remains valid, removes every recorded raw MIME and attachment object, and only then deletes the relational account. Transient provider or object-storage failures retry without losing the cleanup record.

## External configuration

The following real Google Cloud resources are required for continuous delivery:

- a Pub/Sub topic named by `GMAIL_PUBSUB_TOPIC`, with Gmail permitted to publish;
- an authenticated push subscription targeting `/v1/webhooks/google-pubsub`;
- `GOOGLE_PUBSUB_PUSH_AUDIENCE` matching the subscription's OIDC audience;
- `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL` matching its OIDC service account;
- `GOOGLE_PUBSUB_SUBSCRIPTION` matching the full subscription resource name.

Without those resources, the application remains available but Gmail connection/continuous-sync setup is honestly unavailable.
