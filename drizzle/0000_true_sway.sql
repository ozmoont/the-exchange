DO $$ BEGIN
 CREATE TYPE "public"."event_actor" AS ENUM('system', 'admin_user', 'api_key', 'partner_webhook');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."participation_mode" AS ENUM('send_only', 'receive_only', 'send_and_receive', 'inactive');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."partner_kind" AS ENUM('icabbi_fleet', 'external_aggregator', 'external_corporate');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."partner_status" AS ENUM('pending_approval', 'active', 'warning', 'suspended');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."rule" AS ENUM('allow', 'block');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."transit_status" AS ENUM('received', 'routing', 'no_match', 'pushed', 'accepted', 'driver_assigned', 'driver_arrived', 'en_route', 'on_board', 'completed', 'cancelled', 'failed', 'paused', 'error_auth', 'error_other');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'fleet_admin', 'fleet_user');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"actor" "event_actor" NOT NULL,
	"actor_ref" text,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fee_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"originator_id" uuid,
	"recipient_id" uuid NOT NULL,
	"send_fee_pence" integer DEFAULT 20 NOT NULL,
	"receive_fee_pence" integer DEFAULT 40 NOT NULL,
	"tech_fee_pence" integer DEFAULT 0 NOT NULL,
	"tech_fee_bps" integer DEFAULT 0 NOT NULL,
	"booking_fee_pence" integer DEFAULT 0 NOT NULL,
	"admin_fee_pence" integer DEFAULT 0 NOT NULL,
	"admin_fee_bps" integer DEFAULT 0 NOT NULL,
	"apply_to_asap" boolean DEFAULT true NOT NULL,
	"apply_to_prebook" boolean DEFAULT true NOT NULL,
	"apply_to_channels" jsonb DEFAULT '["app","web","phone","api"]'::jsonb NOT NULL,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"effective_to" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "magic_links" (
	"token" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"kill_switch_reason" text,
	"kill_switch_toggled_at" timestamp,
	"kill_switch_toggled_by" text,
	"last_demo_tick_at" timestamp,
	"last_reliability_compute_at" timestamp,
	"last_reconciliation_run_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "partner_rules" (
	"originator_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"rule" "rule" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_rules_originator_id_recipient_id_pk" PRIMARY KEY("originator_id","recipient_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "partner_kind" NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"contact_email" text,
	"participation_mode" "participation_mode" DEFAULT 'inactive' NOT NULL,
	"status" "partner_status" DEFAULT 'pending_approval' NOT NULL,
	"status_reason" text,
	"operating_regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vehicle_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booking_types" jsonb DEFAULT '["asap"]'::jsonb NOT NULL,
	"centroid_lat" real,
	"centroid_lng" real,
	"service_radius_km" integer,
	"credentials" jsonb,
	"adapter_key" text NOT NULL,
	"webhook_url" text,
	"driver_details_required" boolean DEFAULT false NOT NULL,
	"applicant_email" text,
	"application_notes" text,
	"acceptance_rate" real,
	"completion_rate" real,
	"auto_reroute_rate" real,
	"median_acceptance_ms" integer,
	"total_pushed_7d" integer,
	"metrics_updated_at" timestamp,
	"billing_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transit_id" uuid NOT NULL,
	"status" "transit_status" NOT NULL,
	"detail" jsonb,
	"actor" "event_actor" NOT NULL,
	"actor_ref" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"originator_partner_id" uuid NOT NULL,
	"originator_booking_external_id" text NOT NULL,
	"recipient_partner_id" uuid,
	"recipient_booking_external_id" text,
	"partnership_coid" text,
	"recipient_client_id" text,
	"recipient_server_name" text,
	"recipient_site_id" text,
	"track_my_taxi_link" text,
	"accept_deadline" timestamp,
	"reroute_count" integer DEFAULT 0 NOT NULL,
	"reconciled_at" timestamp,
	"reconciled_originator_total_pence" integer,
	"reconciled_recipient_total_pence" integer,
	"reconciled_drift_pence" integer,
	"reconciled_flagged" boolean DEFAULT false NOT NULL,
	"status" "transit_status" DEFAULT 'received' NOT NULL,
	"booking_payload" jsonb NOT NULL,
	"fee_snapshot" jsonb,
	"routing_trace" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transits_originator_idempotency" UNIQUE("originator_partner_id","originator_booking_external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'fleet_user' NOT NULL,
	"partner_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	"invited_by" text,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"outcome" text,
	"processed_at" timestamp,
	CONSTRAINT "webhook_deliveries_unique" UNIQUE("source","source_event_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fee_configs" ADD CONSTRAINT "fee_configs_originator_id_partners_id_fk" FOREIGN KEY ("originator_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fee_configs" ADD CONSTRAINT "fee_configs_recipient_id_partners_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_rules" ADD CONSTRAINT "partner_rules_originator_id_partners_id_fk" FOREIGN KEY ("originator_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_rules" ADD CONSTRAINT "partner_rules_recipient_id_partners_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transit_events" ADD CONSTRAINT "transit_events_transit_id_transits_id_fk" FOREIGN KEY ("transit_id") REFERENCES "public"."transits"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transits" ADD CONSTRAINT "transits_originator_partner_id_partners_id_fk" FOREIGN KEY ("originator_partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transits" ADD CONSTRAINT "transits_recipient_partner_id_partners_id_fk" FOREIGN KEY ("recipient_partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_category_idx" ON "audit_log" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_email_idx" ON "auth_sessions" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fee_configs_recipient_idx" ON "fee_configs" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fee_configs_pair_idx" ON "fee_configs" USING btree ("originator_id","recipient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "magic_links_email_idx" ON "magic_links" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_rules_recipient_idx" ON "partner_rules" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partners_status_idx" ON "partners" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partners_kind_idx" ON "partners" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_window_idx" ON "rate_limit_buckets" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transit_events_transit_idx" ON "transit_events" USING btree ("transit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transit_events_created_at_idx" ON "transit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transits_status_idx" ON "transits" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transits_recipient_idx" ON "transits" USING btree ("recipient_partner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_partner_idx" ON "users" USING btree ("partner_id");