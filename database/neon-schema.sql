-- PayoutPool Neon PostgreSQL schema v1
-- Run once in Neon SQL Editor. No existing tables are dropped.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS pp_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text UNIQUE NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pp_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 title text NOT NULL,
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','closed')),
 rules_url text,
 starts_at timestamptz,
 ends_at timestamptz,
 funding_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
 CHECK(status <> 'active' OR (funding_verified_at IS NOT NULL AND rules_url IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS pp_prizes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES pp_campaigns(id),
 title text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cash','phone','gift_card','other')),
 currency char(3),
 amount_minor bigint,
 inventory integer NOT NULL DEFAULT 0 CHECK(inventory >= 0),
 weight integer NOT NULL DEFAULT 1 CHECK(weight > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind <> 'cash' OR (currency IS NOT NULL AND amount_minor > 0))
);
CREATE TABLE IF NOT EXISTS pp_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES pp_campaigns(id),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(campaign_id,user_id)
);
CREATE TABLE IF NOT EXISTS pp_spins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES pp_campaigns(id),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 prize_id uuid REFERENCES pp_prizes(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','awarded','no_prize','void')),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 CHECK(status <> 'awarded' OR prize_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS pp_reward_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 spin_id uuid UNIQUE REFERENCES pp_spins(id),
 source_type text NOT NULL CHECK(source_type IN ('verified_campaign','prize_award','adjustment')),
 source_reference text,
 currency char(3) NOT NULL,
 amount_minor bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','reversed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pp_payouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES pp_users(id),
 currency char(3) NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','paid','rejected')),
 provider_reference text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pp_ad_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid REFERENCES pp_users(id),
 network text NOT NULL,
 event_type text NOT NULL,
 campaign_reference text,
 verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_entries_user_idx ON pp_entries(user_id);
CREATE INDEX IF NOT EXISTS pp_spins_user_idx ON pp_spins(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS pp_ledger_user_idx ON pp_reward_ledger(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS pp_ad_events_network_idx ON pp_ad_events(network,created_at DESC);
