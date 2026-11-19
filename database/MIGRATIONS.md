# PayoutPool Neon migrations

These files are schema definitions, not proof that a live database has been migrated.

## Order
1. Create a Neon PostgreSQL project.
2. Run `database/neon-schema.sql` in Neon SQL Editor to install the v1 tables.
3. Run `database/migrations/002_rewards_accounts.sql` to extend the schema.
4. Confirm the tables and the `pp_schema_migrations` record.
5. Connect the Neon database through a server-only `DATABASE_URL` environment variable in the hosting platform. Never commit connection strings or expose them to browser JavaScript.

## Verification queries
```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name LIKE 'pp_%'
 ORDER BY table_name;
SELECT * FROM pp_schema_migrations ORDER BY applied_at;
```

## Security and next work
- This migration is additive; no existing entries or balances are fabricated or deleted.
- Daily spin usage must be enforced inside a server-side transaction, locking the per-user/per-campaign/day row before assigning a prize. Browser localStorage is not an authority.
- Authentication and session issuance require server-side implementation. Store only hashes of session tokens.
- Reward balances must be computed from verified ledger entries less approved/paid payouts, not from wheel animation outcomes. Financial transactions must be atomic and audited.
- Encrypt payout destinations and delivery addresses in the backend before storing ciphertext. Never store encryption keys in Neon or the repository.
- Only activate campaigns after funding and rules have been verified. Do not reward ordinary advertising clicks or views.
- No SQL has been executed against Neon by this GitHub change. Live migration requires the Neon connection.
