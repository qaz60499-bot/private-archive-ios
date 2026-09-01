# Private Archive — Product Brief

## Product thesis

Private Archive is a single-owner photo, video, and file archive. Telegram private storage keeps original media; a Cloudflare Worker provides the authenticated API and synchronization layer; D1 stores only lightweight metadata and relationships; Queues and Workers AI organize small previews asynchronously. The web entry should feel like a quiet personal archive, never a Telegram drive wrapper or a SaaS dashboard.

## Audience and context

- Audience: one owner using a phone and desktop to collect, rediscover, and organize a private media history.
- Context: short capture/upload sessions on mobile, longer browsing and organizing sessions on desktop, sometimes with unreliable connectivity.
- Primary job: save an item once and trust that it appears in a calm, searchable timeline whether it entered from the PWA or Telegram.

## Product principles

1. Telegram stores heavy bytes; D1 stores the index and organization only.
2. Web and Telegram ingestion converge on `ingest → normalize → preview → analyze → index → ready`.
3. Upload success is independent from AI success.
4. Real metadata outranks inference: EXIF time and GPS are authoritative; AI may classify a scene but never invent a precise place or identity.
5. Secrets stay in Cloudflare Secrets and never appear in frontend bundles, source, fixtures, logs, or D1.
6. The first release is single-owner and Cloudflare Access is the outer authentication boundary.

## Scope

### Required flows

- Timeline with cursor pagination, stable media dimensions, lazy previews, loading, empty, and error states.
- Two-stage web upload: reserve metadata, then stream the original to Telegram; upload preview separately.
- Offline capture queue backed by IndexedDB and OPFS when available; resume on reconnect or foreground.
- Telegram webhook ingestion for owner private messages and approved storage-channel posts, with secret and source validation.
- Favorites, albums, search/filtering, discover categories, places, people-count grouping, videos, files, queue, settings, and soft delete.
- Dark media viewer with metadata, keyboard navigation, touch-aware controls, and Telegram fallback for originals over 20 MB.
- Queue-driven preview analysis and deterministic tag normalization.
- First-run setup status without ever accepting or echoing the bot token in the client.

### Explicit non-goals

- Multi-user accounts, public registration/sharing, social features, collaboration.
- Face identity recognition, vector search, full OCR, long AI descriptions.
- R2 original storage, VPS, Tunnel, Local Bot API, or files over 48 MB.
- Heavy 3D scenes, model-led hero experiences, dense particles, neon gradients, or dashboard metrics. A lightweight decorative archive-folio atmosphere is allowed when it never competes with media, blocks content, or survives reduced-motion/data-saving preferences.

## Storage and size contract

- `≤20 MB`: upload, preview, in-app media retrieval/download, analysis, and Telegram sync.
- `>20 MB and ≤48 MB`: upload to Telegram, preview-led browsing/analysis, search and organization; the original opens in Telegram.
- `>48 MB`: reject before reservation and explain the Cloud Bot API constraint.
- Worker code must forward the request `ReadableStream`; it must not call `arrayBuffer()` on original upload content.
- Queue messages contain identifiers only, never binary or base64 media.

## Information architecture

| Route | Purpose |
| --- | --- |
| `/` | Chronological archive and active filters |
| `/discover` | Visual entry points by people, scene, place, and media type |
| `/people` | People / portrait / group / coarse person-count groups |
| `/places` | Location groups and unresolved GPS items |
| `/albums` | Owner-created albums |
| `/videos` | Video-only timeline |
| `/files` | Non-photo/video files |
| `/favorites` | Favorite items |
| `/queue` | Online and offline upload jobs with retry controls |
| `/settings` | Integration readiness, limits, AI/privacy, and setup checklist |

## Domain cues and signature

Real-world cues: archival accession labels, contact sheets, museum captions, linen paper, graphite ink, film-frame numbering, date dividers, and a dark viewing room. The signature element is the **archive folio**: each timeline section begins with a restrained vertical date marker and accession count, while media remains visually dominant.

Template defaults deliberately rejected:

- Generic gradient hero → immediate archive timeline with a quiet editorial masthead.
- KPI cards → visual categories and dated media folios.
- Floating glass panels → opaque warm surfaces, hairline separators, and near-flat depth.

## Acceptance criteria

- Local mock mode builds and runs without Telegram credentials, while production mode fails closed when required bindings or secrets are absent.
- D1 migrations contain metadata and relations only; no BLOB/base64 media columns.
- Mock integration tests prove web upload and Telegram webhook converge into timeline records.
- Unit coverage includes source validation, webhook secret, size tiers, idempotency, time precedence, tag normalization, queue retry, and 20/48 MB behavior.
- Playwright covers image/video upload, webhook mock, favorite, album creation, search, mobile navigation, offline queue/retry, and viewer.
- The PWA is installable and its shell works offline; the UI truthfully describes background-sync limitations.
- Verified at 375, 430, 768, 1280, and 1440 px, including reduced motion, keyboard focus, dialogs, and no horizontal overflow.

## Delivery constraints

- One Cloudflare Worker project serves static Vite assets and `/api/*`.
- React + TypeScript + Vite frontend; Hono Worker; D1, Queue, Workers AI; minimal dependencies.
- No real deployment or Telegram live integration without owner-provided Cloudflare credentials and Secrets.
