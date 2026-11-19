-- Additive API support. No fake funded campaigns or awards.
BEGIN;
CREATE TABLE IF NOT EXISTS pp_auth_credentials (
 user_id uuid PRIMARY KEY REFERENCES pp_users(id) ON DELETE CASCADE,
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pp_spins ADD COLUMN IF NOT EXISTS reward_snapshot_minor bigint;
ALTER TABLE pp_spins ADD COLUMN IF NOT EXISTS reward_currency char(3);
ALTER TABLE pp_payouts ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS pp_payouts_idempotency_idx ON pp_payouts(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS pp_ledger_balance_idx ON pp_reward_ledger(user_id,currency,status);
INSERT INTO pp_schema_migrations(version) VALUES ('003_api_auth') ON CONFLICT DO NOTHING;
COMMIT;
