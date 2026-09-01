# Living Personal Archive — Production Delivery

Date: 2026-08-31

## Scope

This delivery keeps the existing Telegram + D1 + Cloudflare Worker architecture and upgrades the personal archive into a restrained living archive: CSS-first hierarchy, GSAP editorial sequencing, deterministic memory cover selection, factual monthly timeline markers, quiet album depth, and a short Viewer darkroom entrance.

No ScrollTrigger, scroll-jacking, continuous hero Three.js loop, mouse follower, or full-site floating-photo animation was introduced.

## Local gates

- `npm run config:validate`: PASS
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm run test`: PASS — 14 files / 57 tests
- `npm run build`: PASS
- Initial app JS: 151.42 KiB gzip
- GSAP remains a separate chunk: 27.33 KiB gzip
- Three.js remains a separate optional chunk: 127.85 KiB gzip
- `personal-desktop` home cover remains DOM/CSS-first and does not boot Three.js.

Fresh-server Playwright validation was run per spec so each spec receives a fresh Wrangler/D1 lifecycle. Aggregate result across the nine spec files: 70 passed, 44 conditional platform skips, 0 failed.

Validated areas include Timeline, Viewer fit/zoom/navigation/mobile gestures, Albums, Search, Discover, Upload, 20/100/240 item scheduling, pause/resume, 429 Retry-After, offline recovery, deduplication, Web + Telegram ingestion convergence, edge preview cache behavior, Access reauthentication states, responsive cover geometry, mobile navigation, and reduced motion.

The repository `run-split.mjs` was also made Windows-safe by invoking the local Playwright CLI through the active Node runtime instead of `spawnSync(npx.cmd)`. A single shell invocation of all specs exceeds the current DevSpace command runtime ceiling, so the final release gate was completed as per-spec fresh-server runs rather than weakening lifecycle isolation.

## Production D1 pre-deploy baseline

Remote migrations: no pending migrations.

Personal workspace:

- total assets: 78
- ready: 65
- pending_upload: 3
- trashed: 10
- ready assets linked to storage objects: 65 / 65
- active storage objects: 65
- broken asset -> storage references: 0
- active unreferenced storage objects: 0
- missing storage object links for stored/queued/analyzing/ready/limited assets: 0
- duplicate Telegram message groups: 0
- missing asset_search rows: 0

The 13 assets without a current storage object are exactly the three `pending_upload` rows plus ten `trashed` rows; this is not a ready-asset storage regression.

## Cloudflare deployment

- Worker: `private-archive`
- Custom domain: `photo.joye.cc.cd`
- Production version ID: `1829d812-12da-4b8a-8c86-d058903bb316`
- Worker startup time: 9 ms
- `wrangler deploy --dry-run`: PASS
- Production deploy: PASS
- Main Worker only; Telegram webhook Worker was not redeployed because this visual/motion release did not change that deployment boundary.

Unauthenticated production checks after deploy:

- `/` -> Cloudflare Access 302
- `/api/health` -> Cloudflare Access 302

This confirms the outer Access boundary remains active.

## Production D1 post-deploy gate

Post-deploy values exactly match the pre-deploy snapshot:

- total assets: 78
- ready: 65
- pending_upload: 3
- trashed: 10
- linked assets: 65
- active storage objects: 65
- broken asset -> storage references: 0
- active unreferenced storage objects: 0
- missing storage object links: 0
- duplicate Telegram message groups: 0
- missing search rows: 0

No production D1 migration or photo/storage cleanup was executed during this release.

## Windows distribution

`desktop/windows/build-desktop.cmd` completed all six build stages and synchronized `release/final` to the canonical `release` directory.

Canonical launcher entry remains:

`https://photo.joye.cc.cd/?app=personal-desktop`

The rebuilt `PrivateArchive.exe` was actually launched and Windows reported an Edge App process using exactly that production URL.

SHA256 manifests were regenerated and match the computed binaries. `release` and `release/final` match for the EXEs, ZIP, README, and checksum manifests.

## Runtime cleanup

Stale project-owned Wrangler dev trees on historical validation ports 8810, 8822, 8825, 8826, 8827 and 8828 were terminated by their exact project-owned process trees. No global Node/workerd kill was used. Final project dev runtime count: 0.

## Remaining production-only validation boundary

An authenticated Cloudflare Access production smoke test could not be completed automatically in this conversation environment. Access successfully sent the owner OTP, but the Gmail connector was blocked by the host with a developer-MCP-only restriction. The assistant did not bypass Access, inspect browser credentials, create a service token, or claim authenticated production success without evidence.

Local/fresh-server E2E covers the authenticated application behavior and production integrity/deployment gates are green; the remaining manual observation is login-through-Access followed by a short real production pass over Timeline, Viewer, Discover, Album, Search, Upload/Batch/Dedup and webhook status.
