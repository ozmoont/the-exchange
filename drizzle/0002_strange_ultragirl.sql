CREATE TABLE IF NOT EXISTS "synthetic_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ran_at" timestamp DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"transit_id" uuid,
	"originator_partner_id" uuid,
	"elapsed_ms" integer NOT NULL,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "auto_suspend_cooldown_until" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "synthetic_test_runs_ran_at_idx" ON "synthetic_test_runs" USING btree ("ran_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partners_participation_mode_idx" ON "partners" USING btree ("participation_mode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transit_events_transit_created_idx" ON "transit_events" USING btree ("transit_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transits_created_at_idx" ON "transits" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transits_originator_idx" ON "transits" USING btree ("originator_partner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transits_recipient_created_idx" ON "transits" USING btree ("recipient_partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transits_accept_deadline_idx" ON "transits" USING btree ("accept_deadline") WHERE status = 'pushed' AND accept_deadline IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transits_reconciled_flagged_idx" ON "transits" USING btree ("id") WHERE reconciled_flagged = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at" DESC NULLS LAST);