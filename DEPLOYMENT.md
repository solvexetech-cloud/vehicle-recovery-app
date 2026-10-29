# Deployment Guide (Free-First)

**Current state:** Phases 1-11 complete, 300+ tests passing.
**Local dev:** `npm start` on port 3000 (SQLite in `data/app.db`).

## Prerequisites for ANY deployment

1. HTTPS reverse proxy (Railway/Render/Fly offer this automatically)
2. `NODE_ENV=production` in env vars
3. `SEED_SUPER_ADMIN_PASSWORD` **unset** (auto-seed disabled in production)
4. Verified backup procedure (see `scripts/backup.ps1`)
5. `MFA_REQUIRED_FOR_SUPER_ADMIN=true` (recommended for production)

## Free-tier hosting options (verified)

| Platform | Free tier | Node.js | SQLite persistence | Notes |
|---|---|---|---|---|
| **Railway** | $5 credit/mo (one-time) | ✅ | Volume required | Best DX; volume for `data/` |
| **Render** | 750 hrs/mo | ✅ | Free tier wipes disk | Use external DB or accept data loss |
| **Fly.io** | 3 shared VMs | ✅ | Volume required | Fast global; sqlite-friendly |
| **Cloudflare Workers** | 100K req/day | ❌ (Node) | ❌ | Not compatible (no node:sqlite) |

**Recommendation:** Railway $5 one-time credit + 1GB volume. Lasts months under dev load.

## Deployment steps (Railway example)

1. Push code to GitHub (already done — commit `5e29f6d`)
2. Railway dashboard → New Project → Deploy from GitHub
3. Add `Volume` mounted at `/app/data` (for DB + uploads)
4. Set env vars:
   - `NODE_ENV=production`
   - `PORT=3000` (Railway overrides)
   - `DB_PATH=/app/data/app.db`
   - `UPLOADS_DIR=/app/data/uploads`
   - `MFA_REQUIRED_FOR_SUPER_ADMIN=true`
   - Do NOT set `SEED_SUPER_ADMIN_PASSWORD` — create first admin via SQL
5. Deploy → Railway builds via `package.json` `start` script
6. Add custom domain (free HTTPS)
7. Test `/health` endpoint

## Post-deploy checklist

- [ ] `/health` returns `database: ok`
- [ ] Login as super admin works (via manual SQL seed)
- [ ] Backup script scheduled (Railway cron: `node scripts/backup.js` — port to JS for prod)
- [ ] `MFA_REQUIRED_FOR_SUPER_ADMIN=true` and super admin has enrolled
- [ ] `data/app.db` and `data/uploads/` on persistent volume
- [ ] HTTPS enforced (auto via Railway/Render/Fly)
- [ ] Logs monitored for `[notify]` / `[notifyBookingCustomer]` errors

## Backup strategy

- **Dev:** `.\scripts\backup.ps1` — creates `data/backups/app-YYYYMMDD-HHMMSS.db`, keeps 7
- **Prod:** port to `.js` (Node) and schedule via cron / Railway scheduler
- **Monthly:** copy latest backup off-platform (S3 free tier, Google Drive, etc.)
- **Test restore:** `.\scripts\restore.ps1 -BackupFile <path>` monthly

## Known limitations

- **TD-099** — accept/complete notifications. Phase 11 fixed; verify via `tests/notifications11.test.js`
- Real payment gateway deferred (test-mode only)
- Live map deferred (haversine + mock in dev)
- Push notifications deferred (in-app only)
- Payout to bank deferred (manual workflow records only)