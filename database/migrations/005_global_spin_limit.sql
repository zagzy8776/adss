BEGIN;
CREATE TABLE IF NOT EXISTS pp_anonymous_global_daily_spins (
 visitor_id uuid NOT NULL REFERENCES pp_anonymous_visitors(id),
 spin_date date NOT NULL,
 used smallint NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 2),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(visitor_id,spin_date)
);
INSERT INTO pp_anonymous_global_daily_spins(visitor_id,spin_date,used)
 SELECT visitor_id,spin_date,LEAST(2,SUM(used))::smallint
 FROM pp_anonymous_daily_spins GROUP BY visitor_id,spin_date
 ON CONFLICT(visitor_id,spin_date) DO UPDATE SET used=GREATEST(pp_anonymous_global_daily_spins.used,EXCLUDED.used);
INSERT INTO pp_schema_migrations(version) VALUES('005_global_spin_limit') ON CONFLICT DO NOTHING;
COMMIT;