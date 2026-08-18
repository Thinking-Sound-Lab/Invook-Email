ALTER TABLE "mailbox_change_events" DROP CONSTRAINT "mailbox_change_events_type_check";--> statement-breakpoint
UPDATE "mailbox_change_events"
SET "change_type" = 'replica_ready', "payload" = '{}'::jsonb
WHERE "change_type" = 'repair_complete';--> statement-breakpoint
ALTER TABLE "mailbox_change_events" ADD CONSTRAINT "mailbox_change_events_type_check" CHECK ("mailbox_change_events"."change_type" in ('replica_ready', 'history_applied', 'drafts_changed', 'labels_changed'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_invook_mailbox_change()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'invook_mailbox_changes',
    json_build_object(
      'eventId', NEW.id,
      'userId', NEW.user_id,
      'accountId', NEW.account_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
