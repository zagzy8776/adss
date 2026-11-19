BEGIN;
CREATE TABLE IF NOT EXISTS pp_anonymous_visitors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 token_hash text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
ALTER TABLE pp_spins ADD COLUMN IF NOT EXISTS anonymous_visitor_id uuid REFERENCES pp_anonymous_visitors(id);
ALTER TABLE pp_daily_spin_usage ADD COLUMN IF NOT EXISTS anonymous_visitor_id uuid REFERENCES pp_anonymous_visitors(id);
CREATE TABLE IF NOT EXISTS pp_anonymous_daily_spins (
 visitor_id uuid NOT NULL REFERENCES pp_anonymous_visitors(id),
 campaign_id uuid NOT NULL REFERENCES pp_campaigns(id),
 spin_date date NOT NULL,
 used smallint NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 2),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(visitor_id,campaign_id,spin_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS pp_anonymous_spin_request_unique ON pp_spins(anonymous_visitor_id,request_id) WHERE anonymous_visitor_id IS NOT NULL AND request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pp_anonymous_spin_history_idx ON pp_spins(anonymous_visitor_id,created_at DESC);
ALTER TABLE pp_prize_claims ADD COLUMN IF NOT EXISTS anonymous_visitor_id uuid REFERENCES pp_anonymous_visitors(id);
ALTER TABLE pp_reward_ledger ADD COLUMN IF NOT EXISTS anonymous_visitor_id uuid REFERENCES pp_anonymous_visitors(id);
ALTER TABLE pp_payouts ADD COLUMN IF NOT EXISTS anonymous_visitor_id uuid REFERENCES pp_anonymous_visitors(id);
ALTER TABLE pp_spins ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE pp_prize_claims ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE pp_reward_ledger ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE pp_payouts ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE pp_spins ADD CONSTRAINT pp_spin_owner_check CHECK (num_nonnulls(user_id,anonymous_visitor_id)=1);
ALTER TABLE pp_prize_claims ADD CONSTRAINT pp_claim_owner_check CHECK (num_nonnulls(user_id,anonymous_visitor_id)=1);
ALTER TABLE pp_reward_ledger ADD CONSTRAINT pp_ledger_owner_check CHECK (num_nonnulls(user_id,anonymous_visitor_id)=1);
ALTER TABLE pp_payouts ADD CONSTRAINT pp_payout_owner_check CHECK (num_nonnulls(user_id,anonymous_visitor_id)=1);
CREATE TABLE IF NOT EXISTS pp_anonymous_rate_events (
 id bigserial PRIMARY KEY,
 network_hash text NOT NULL,
 event_type text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_anonymous_rate_events_idx ON pp_anonymous_rate_events(network_hash,event_type,created_at DESC);
INSERT INTO pp_schema_migrations(version) VALUES ('004_anonymous_rewards') ON CONFLICT DO NOTHING;
COMMIT;
