BEGIN;
CREATE TABLE IF NOT EXISTS pp_claim_contacts(
 claim_id uuid PRIMARY KEY REFERENCES pp_prize_claims(id),
 visitor_id uuid NOT NULL REFERENCES pp_anonymous_visitors(id),
 email text NOT NULL,
 phone text NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_claim_contacts_email_idx ON pp_claim_contacts(lower(email));
CREATE TABLE IF NOT EXISTS pp_claim_notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 claim_id uuid NOT NULL REFERENCES pp_prize_claims(id),
 title text NOT NULL,
 message text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 read_at timestamptz
);
CREATE INDEX IF NOT EXISTS pp_claim_notifications_claim_idx ON pp_claim_notifications(claim_id,created_at DESC);
INSERT INTO pp_schema_migrations(version) VALUES('006_anonymous_claim_contact') ON CONFLICT DO NOTHING;
COMMIT;