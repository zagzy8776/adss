# PayoutPool operational backend

## Implemented
- Vercel Node serverless API at `api/[...path].js`, backed by `api/index.js`.
- Neon migrations 001 (base schema), 002 (accounts/rewards), 003 (API auth).
- Email/password signup and login with scrypt password hashing and hashed, HttpOnly, Secure cookie sessions.
- Database-enforced two spins per UTC day per user and campaign; serialized concurrent requests; idempotent request IDs; weighted prize inventory assignment.
- Wallet ledger with pending/verified states, payout requests reserved against verified funds, manual payout review and audit.
- Account interface on homepage, plus `admin.html` for campaign drafts, prize inventory, claim and payout review.
- Existing ad scripts and capture funnel remain in place.

## Required Vercel environment variables
- `DATABASE_URL`: Neon PostgreSQL connection string (server only).
- `ADMIN_API_TOKEN`: strong random admin token, independent of Cloudflare Worker `ADMIN_TOKEN`. **Never expose it in client code.**
- Redeploy the production environment after adding variables.
- Test `GET /api/health` for `{"ok":true,"database":"connected"}`.
- Visit `/admin.html` and enter the admin API token only in the input.

## Important operational limitations
- No campaign is activated automatically. Activation requires **independent verification of actual prize funding**, published eligibility and rules, and a safe audited activation workflow. The API deliberately blocks direct activation.
- Payouts are **requests**, not bank transfers. Mark paid only after a real transfer is confirmed and its reference recorded. A payment provider, KYC/AML, payout destination collection/encryption, tax/legal compliance and reconciliation are still needed for automated cashouts.
- User email ownership verification, password reset, anti-bot controls, account rate limiting, and production load/security testing are not yet complete. Do not market the system as production-ready for real-money awards.
- Admin dashboard currently uses a secret admin API token, not role-based staff accounts. Avoid sharing that token.
- A verified claim changes a pending ledger entry to verified. Only funded, authorized prize claims should be approved.
- Existing local browser spin history is *not* migrated into real winnings; it cannot be trusted as proof of a prize.
- Video campaigns, approved rewarded-video provider callbacks, full physical shipment handling and payout automation remain incomplete.
- No end-to-end live Vercel deployment verification has been performed through this change.

## Verification checklist
1. Confirm Neon migration records: `SELECT * FROM pp_schema_migrations ORDER BY version;`
2. Check `GET /api/health` after Vercel deploy.
3. Register and sign in a test account; confirm `GET /api/me`.
4. Verify no campaign is active by default.
5. After funding and campaign activation workflow are independently implemented, test two spins and a rejected third, concurrent requests, and replay of the same request ID.
6. Confirm ledger amounts are pending until review; verify payout requests cannot exceed verified funds.
7. Confirm all admin endpoints reject requests without `ADMIN_API_TOKEN`.
8. Verify ads, funnel and mobile layout separately.
