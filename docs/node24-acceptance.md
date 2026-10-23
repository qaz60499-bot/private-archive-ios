# Node.js 24.22.1 acceptance — 2026-10-22 (America/Los_Angeles)

## Change and scope

The existing shared Windows Node is 24.15.0. This project now has a separately
installed Node 24.22.1 LTS / npm 11.19.1, selected by `scripts/npm-project.ps1`.
The official Windows ZIP SHA256 was verified:
`d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5`.
Both version files, package/lockfile engine floor, and the existing iOS CI agree.
No dependency versions or production application code were changed.

Production runs on Cloudflare Workers; this upgrades its build, test, and
deployment tool runtime. The machine-wide Node and installed Build 12 are
unchanged. Historical Wrangler 4.120.1 proxy disconnections are recorded in
`docs/design/art-threejs-v2-delivery.md`; they are not proven Node defects.

## Verified local results

- Clean `npm ci`: 585 packages installed successfully with the existing lockfile.
- `npm run check`: configuration, ESLint, TypeScript, 45 files / 195 tests,
  and production Vite/PWA build passed.
- Existing native upload source verifier: `IOS_BACKGROUND_UPLOAD_SOURCE_OK`.
- Wrangler 4.127.1 `deploy --dry-run`: success, no production deployment.
- Controlled `npm run test:e2e -- web-upload-portal.spec.ts
  upload-acknowledgement.spec.ts upload-confirmation-recovery.spec.ts
  p0-boot-media.spec.ts`: 17 passed, 9 explicit platform skips, 0 failed.
  Covers desktop/mobile web upload entry, metadata, strict proof/idempotent
  replay, invalid confirmation retention/recovery, navigation and image fallback.
- E2E used existing system Chrome 155.0.8059.86 through the existing
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` option. Lock removed and project
  workerd process count zero after completion.
- Three bounded production health reads: HTTP 200 / `ok: true` (2500, 428,
  422 ms). No production SQL, uploads, or data cleanup used for this phase.
- Independent read-only review found no pin/wrapper inconsistency.

The first browser run could not launch because the default Playwright Headless
Shell was absent. A browser install had already completed when the user added
the preference to reuse Chrome; the successful rerun used system Chrome.
No application patch was made for that environment failure. The first lint
invocation was also stopped after detecting that the new portable runtime
needed an explicit ESLint ignore; `.runtime` is now excluded.

Evidence logs are in `work/node24-{ci,check,e2e,worker-dry-run,ios-upload}.log`.

## Limits and remaining findings

The original dependency audit reports 14 affected packages (8 high, 6 moderate).
The production-only audit reports one moderate package, Hono. These are separate
from the patched Node runtime; audit JSON is preserved in `work/node24-audit*.json`.
No broad dependency updates, forced audit fixes, or downgrades were applied.
The existing Three.js optional chunk size warning also remains.

The macOS/iOS CI run for this exact change is pending. This report does not
claim a new IPA installation or improvements to CPU, heat, upload throughput,
or the unresolved Build 12 network long tail. Those belong to the next measured
performance phase. Setup and desktop preview limitations: `docs/node-runtime.md`.
