# Private Archive — Design System

## Direction

**Quiet Warm Archive / Editorial Contact Sheet / Personal Memory Index.** The interface resembles a warm museum study room crossed with a photographic darkroom: mineral paper, graphite UI typography, serif exhibition titles, restrained olive accents, registration marks, contact-sheet traces, accession codes, and image-first layouts. The unfiltered home timeline uses one signature **Archive Composition** built with CSS/DOM: three flat photographic frames, index numbers, date marks, crop/registration marks and a contact rail. Real previews may fill those frames only after the cover itself is already painted; preview failure never removes the composition. The hero must never read as a planet, celestial instrument, atom model, sci-fi HUD, centered 3D demo, or SaaS dashboard. Three.js is not part of the home cover and is never required by `personal-desktop`.

## Tokens

### Color roles

| Token | Light value | Role |
| --- | --- | --- |
| `--canvas` | `#F1EFE9` | warm page field |
| `--surface` | `#F8F7F2` | sheets and elevated reading surfaces |
| `--surface-strong` | `#E8E5DC` | selected rows and muted panels |
| `--ink` | `#20231F` | primary text and icon strokes |
| `--ink-muted` | `#6D716A` | captions and metadata |
| `--line` | `#D7D4CB` | hairlines and dividers |
| `--accent` | `#66745E` | selected, success, focus-adjacent detail |
| `--accent-soft` | `#DDE3D8` | quiet selected background |
| `--danger` | `#9A4D43` | destructive and failed status only |
| `--viewer` | `#121412` | dark lightbox field |
| `--viewer-ink` | `#F0F1EC` | viewer content |

No pure white page, saturated blue/purple, neon gradient, glow, or large translucent glass treatment.

### Typography

UI/body font stack: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`.

Display title stack: `"Iowan Old Style", Baskerville, "Times New Roman", "Noto Serif SC", "Songti SC", serif`. Keep it local-only: no remote font dependency.

| Level | Size / line-height | Weight / use |
| --- | --- | --- |
| Display | `clamp(2.35rem, 4.7vw, 5.35rem) / 0.94` | serif 400, exhibition/page masthead |
| H1 | responsive display scale | serif 400 on art-directed page intros; sans remains for functional dialogs |
| H2 | `1.25rem / 1.25` | 560, timeline date and panel title |
| H3 | `1rem / 1.35` | 600, card / group title |
| Body | `0.9375rem / 1.6` | 400, core reading |
| Label | `0.75rem / 1.25` | 620, letter-spaced archival labels |
| Caption | `0.8125rem / 1.45` | 400, metadata |

Dates may use tabular numerals. Uppercase labels use `0.08em` tracking and never carry long copy.

### Spacing scale

`2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 112px`.

- Minimum touch target: 44×44 px; primary mobile upload control: 52×52 px.
- Desktop content padding: 32–56 px; mobile: 16–20 px.
- Text measure: 66 characters for explanatory copy.

### Radius, line, and depth

- `--radius-xs: 4px`, `--radius-sm: 8px`, `--radius-md: 12px`, `--radius-lg: 18px`.
- Media tiles use 4–8 px; sheets/dialogs use 18 px; no pill-shaped content cards.
- Most structure uses 1 px hairlines, not boxed cards.
- Shadows: `0 12px 32px rgba(31, 34, 29, .09)` for sheets; `0 2px 10px rgba(31, 34, 29, .06)` for transient controls only.

## Layout

### Desktop

- 92 px fixed navigation rail with icon, short label, and visible focus state.
- Top command strip remains visually light; search is the dominant control, upload is a compact accent action.
- Main archive area uses `minmax(0, 1fr)` and a maximum readable heading width, while the media wall can extend wide.
- The unfiltered home cover is intentionally contained: roughly 400–590 px on desktop, with a balanced text/Archive Composition split and no negative overlap into the first Timeline controls.
- The Windows `personal-desktop` surface uses the same CSS/DOM Archive Composition rather than maintaining a second visual system. Its 58 px command strip and short-height rules keep 1366×768 usable while preserving a complete right-side frame stack.
- The Archive Composition paints synchronously without Three.js. Optional real previews are lazy/non-blocking content inside the frames; the paper/frame skeleton remains visible if previews are slow or unavailable.
- At ≥1280 px, media uses a stable justified-style CSS grid based on stored aspect ratio; sections render incrementally.

### Tablet

- At 768–1023 px the rail becomes a compact 72 px icon rail.
- Page padding reduces to 24 px; three-to-four media columns depending on aspect ratio.

### Mobile

- Desktop rail is removed; a fixed five-position bottom area presents Library, Discover, a centered Upload action, Albums, and Search.
- Content reserves safe-area bottom padding. The top bar stays compact and never duplicates the full desktop command strip.
- Sheets become bottom sheets with a visible heading, close control, scroll containment, and sticky primary action.
- Metadata in the viewer becomes a pull-up sheet; core close/favorite controls remain reachable without gestures.

## Media grid rules

- Store and apply width/height before image load; use `aspect-ratio` to prevent layout shift.
- Desktop grid: 4–6 tracks with selected editorial spans; tablet: 3 tracks; mobile: 2 tracks with occasional full-width landscape items.
- Tile gaps: 8 px desktop, 5–6 px mobile. Avoid masonry scripts that reorder reading/keyboard sequence.
- All list images use previews, `loading="lazy"`, decoded asynchronously, and never request originals.
- Hover-capable devices may scale the image to at most `1.012`; touch devices receive a pressed opacity state instead.
- Video, limited-analysis, favorite, and queued markers occupy predictable corners and never cover the subject center.

## Components and states

- Navigation: flat rows, accent rule for active state, no filled dashboard tiles.
- Search: explicit label, clear button, submit behavior, keyboard shortcut hint on desktop only.
- Filter chips: compact 32–36 px controls; selected state uses accent-soft and a checked icon.
- Category/place/album cards: image-led with one quiet metadata line; borders only where separation needs them.
- Upload sheet: file chooser/drop zone, per-file preview, size-tier explanation, progress/state, retry, and remove actions.
- Loading: reserved skeleton geometry with a low-contrast paper shimmer disabled under reduced motion.
- Empty: useful next action and route-specific explanation; never decorative filler.
- Error: plain-language recovery action and diagnostic code only when useful.
- Focus: 2 px `--accent` outline with 2 px offset; focus is never removed.

## Motion

| Motion | Duration | Easing |
| --- | --- | --- |
| press / hover | 140–180 ms | `cubic-bezier(.2,.7,.2,1)` |
| chip / local state | 180–220 ms | same |
| sheet / dialog | 220–260 ms | `cubic-bezier(.22,.8,.24,1)` |
| page content reveal | 240–300 ms | same, opacity + ≤8 px translate |

GSAP orchestrates the page heading and archive-folio reveal so the interface settles like a catalog being opened. Route changes also trigger a short exposure veil in the background, while the active navigation glyph recalibrates and the folio rule draws before the media enters. Content motion stays local: opacity, small transforms, restrained stagger, and no scroll-jacking or layout animation.

The home Archive Composition does not run a continuous animation loop or ScrollTrigger scrub. Hover-capable devices may move the three flat frames by only a few pixels; reduced motion removes even that. Search/category/focused-search states revert to the compact PageIntro so task-oriented browsing does not pay the spatial cost of the cover.

The Windows `personal-desktop` route deliberately does not start Three.js and keeps its right-side contact-film composition CSS-first and immediately visible. This keeps the executable's cold-open response fast while preserving the same archive design language.

The optional browser ambient background may remain a dynamically loaded full-viewport Three.js photographic chemistry field on non-personal surfaces, with a static CSS fallback and pause/offscreen behavior. It is subordinate atmosphere, not a product dependency: the home cover, navigation, search, upload, selection, viewer, Timeline and error states must all work without it. No GLB, HDRI, remote texture, real-time shadow or heavy post-processing is allowed.

### Motion / Memory Interaction Map

Use a **70 / 20 / 10** balance: roughly 70% of the product stays visually still, 20% provides local feedback, and only about 10% is allowed to become an emotional memory beat.

| Surface | Default state | Response | Memory role | Implementation rule |
| --- | --- | --- | --- | --- |
| Home Archive Composition | still, fully painted | tiny pointer-proximity depth on hover-capable desktop; short editorial entrance | occasional deterministic mix of recent / older / favorite real assets | CSS + Pointer Events first; no loop, no Three.js, no random layout |
| Timeline month boundary | natural browser scrolling | month label hands off with sticky CSS geometry | factual count / time-of-day note only when supported by current asset data | no ScrollTrigger, pinning or scroll-jacking |
| Timeline media tile | still image | ≤1.5% zoom and metadata exposure | date + real album/tag context; never invented place or feeling | hover may enrich desktop, but tap/focus/open Viewer remains a complete non-hover path |
| Viewer | dark, quiet room | one short backdrop/media/metadata entrance, then complete stillness | photograph remains dominant; metadata reads like the back of a print | no continuous motion; zoom/pan gestures always win over decoration |
| Albums | organized stack | shallow cover-layer separation on hover/focus/tap-capable path | suggests a physically gathered set without card theatrics | CSS transforms only; no flying/rotating stacks |
| Search / Settings / Activity / Trash | functional and quiet | ordinary press/focus/status transitions | none unless the route already contains real archive data | do not add emotional motion to utility work |

Memory copy may describe **what the archive proves** (counts, dates, time-of-day distribution, albums, tags, elapsed time). It must never claim what the owner felt, why an event mattered, whether they miss a place, or any other unsupported biography.

The web adaptation borrows video-directing ideas only as sequencing discipline: **establish → reveal → breathe → return to stillness**. It explicitly rejects video-runtime concepts such as perpetual animated backgrounds, section-by-section visual novelty, strobing, high-density graphic cards and kinetic typography as defaults.

### Iconography

Primary navigation uses a custom `ArchiveGlyph` SVG family rather than generic application icons. Every symbol shares a 32×32 field, fine graphite core strokes, a broken accession orbit, and one registration dot. The active orbit draws on route entry and its dot makes one slow circuit; reduced motion freezes both. Domain-specific icons inside content panels may retain Lucide where their literal meaning is more important than brand expression.

### Reduced motion

Under `prefers-reduced-motion: reduce`, remove transforms, smooth scrolling, shimmer, and animated layout changes; dialogs and status changes remain immediate and understandable. No function depends on animation.

## Lightbox

- Full-viewport `--viewer` background with minimal top tools and media centered in the available region.
- Desktop metadata panel is 320–380 px on the right; mobile panel is a bottom sheet up to 72vh.
- Left/right keyboard navigation, Escape close, focus trap, focus return, and a visible close label for assistive technology.
- Original retrieval follows size policy: in-app for ≤20 MB, Telegram action plus explanatory copy for 20–48 MB.

## Accessibility and performance budgets

- WCAG 2.2 AA contrast for text and controls; logical landmarks and heading order.
- Inputs have persistent labels; upload and queue updates use a polite live region.
- Dialogs trap focus and restore it; all actions work with keyboard and pointer.
- Initial application JS target ≤260 KB gzip excluding optional dynamically loaded ambient Three.js/GSAP chunks. The home Archive Composition must not import Three.js.
- CLS target ≤0.1; media geometry is always reserved; no remote font is required.
- The Archive Composition is decorative (`aria-hidden` at the stage); navigation, Timeline, import, Recent and all other actions remain ordinary accessible DOM controls outside it.
- Breakpoint verification: 375, 430, 768, 1280, 1366×768, 1440×900, 1920×1080 plus 667 px short-height mobile.
