---
"critiqs-react": patch
"critiqs": patch
---

Hardening and policy updates:

- Scope `release.yml` credentials (`persist-credentials: false`, `GH_TOKEN` only on the push/PR step).
- Add `Content-Security-Policy: frame-ancestors 'none'` on `/allow-critiqs` and expand `scripts/site-host.test.ts` folder coverage.
- Fix `packages/backend/scripts/setup-local.ts` startup polling, 503 retries, and signing-key preservation.
- Set the pre-1.0 older-package support window to 6 months (`SUPPORT_MONTHS = 6`; 12 months at 1.0).
- Add a daily per-project safety cap (`MAX_MENTION_EMAILS_PER_PROJECT_DAY = 1_000`) on mention and reply emails across all plans, including paid plans.
