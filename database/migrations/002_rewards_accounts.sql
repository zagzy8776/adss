-- PayoutPool schema extension v2: account security, daily limits, reward claims and fulfillment.
-- Additive and idempotent. Run AFTER database/neon-schema.sql.
-- Does not backfill fabricated awards, change campaign funding or touch ad configuration.
BEGIN;
CREATE TABLE IF NOT EXISTS pp_schema_migrations (
 version text PRIMARY KEY,
 applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pp_users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE pp_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE pp_users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE pp_users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS pp_user_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES pp_users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_sessions_user_idx ON pp_user_sessions(user_id,expires_at DESC);
CREATE TABLE IF NOT EXISTS pp_daily_spin_usage (
 user_id uuid NOT NULL REFERENCES pp_users(id),
 campaign_id uuid NOT NULL REFERENCES pp_campaigns(id),
 spin_date date NOT NULL,
 used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 2),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,campaign_id,spin_date)
);
ALTER TABLE pp_spins ADD COLUMN IF NOT EXISTS spin_date date;
ALTER TABLE pp_spins ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS pp_spins_request_unique ON pp_spins(user_id,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pp_spins_daily_idx ON pp_spins(user_id,campaign_id,spin_date);
CREATE TABLE IF NOT EXISTS pp_streaks (
 user_id uuid NOT NULL REFERENCES pp_users(id),
 campaign_id uuid NOT NULL REFERENCES pp_campaigns(id),
 last_played_date date,
 consecutive_days integer NOT NULL DEFAULT 0 CHECK(consecutive_days >= 0),
 loyalty_points bigint NOT NULL DEFAULT 0 CHECK(loyalty_points >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,campaign_id)
);
CREATE TABLE IF NOT EXISTS pp_prize_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 spin_id uuid NOT NULL UNIQUE REFERENCES pp_spins(id),
 prize_id uuid NOT NULL REFERENCES pp_prizes(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','approved','fulfilled','rejected','cancelled')),
 reviewed_at timestamptz,
 fulfilled_at timestamptz,
 fulfillment_reference text,
 review_note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_claims_user_idx ON pp_prize_claims(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS pp_claims_status_idx ON pp_prize_claims(status,created_at);
CREATE TABLE IF NOT EXISTS pp_payout_destinations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 destination_type text NOT NULL CHECK(destination_type IN ('bank','wallet','other')),
 provider text,
 masked_label text NOT NULL,
 encrypted_details bytea NOT NULL,
 is_default boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pp_payout_default_idx ON pp_payout_destinations(user_id) WHERE is_default;
ALTER TABLE pp_payouts ADD COLUMN IF NOT EXISTS destination_id uuid REFERENCES pp_payout_destinations(id);
ALTER TABLE pp_payouts ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE pp_payouts ADD COLUMN IF NOT EXISTS paid_at timestamptz;
CREATE TABLE IF NOT EXISTS pp_delivery_addresses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 recipient_name text NOT NULL,
 country_code char(2) NOT NULL,
 encrypted_address bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pp_prize_claims ADD COLUMN IF NOT EXISTS delivery_address_id uuid REFERENCES pp_delivery_addresses(id);
CREATE TABLE IF NOT EXISTS pp_admin_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_user_id uuid REFERENCES pp_users(id),
 action text NOT NULL,
 target_type text NOT NULL,
 target_id uuid,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_admin_audit_time_idx ON pp_admin_audit(created_at DESC);
CREATE TABLE IF NOT EXISTS pp_video_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 title text NOT NULL,
 provider text NOT NULL,
 external_reference text,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','ended')),
 rewards_enabled boolean NOT NULL DEFAULT false,
 provider_reward_authorized boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT rewards_enabled OR provider_reward_authorized)
);
CREATE TABLE IF NOT EXISTS pp_video_completions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 video_campaign_id uuid NOT NULL REFERENCES pp_video_campaigns(id),
 provider_event_id text UNIQUE,
 verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_video_user_idx ON pp_video_completions(user_id,created_at DESC);
INSERT INTO pp_schema_migrations(version) VALUES ('002_rewards_accounts') ON CONFLICT DO NOTHING;
COMMIT;
