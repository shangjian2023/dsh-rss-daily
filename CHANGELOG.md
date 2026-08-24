# Changelog

## 0.3.7 - 2026-08-24

Iconography pass — no more emoji.

- All UI glyphs (newspaper, close, plus, check) are now inline Lucide SVG geometry (MIT), inheriting the active theme via `currentColor` — light/dark both correct with zero extra CSS
- Motion: the header button sways gently on a slow loop, panel and settings titles stroke-draw themselves in, check marks draw on appear, close/plus rotate 90° on hover; everything respects `prefers-reduced-motion`
- Panel still closes on Escape; touch-target sizing is unchanged
## 0.3.6 - 2026-08-24

Hardening pass (second review sweep + official-style audit).

- **TLS certificate verification is now on by default** for all feed / page / API fetches (it was globally disabled, which allowed a MITM to inject content into the digest). Sources with broken or self-signed chains retry once unverified per request and log a `[tls]` note to stderr
- Fetch stage `LOCKED` (another instance holds the state lock) is no longer misreported as "no fresh news"; the agent tool now says a concurrent run holds the lock
- Agent tool `redo` no longer deletes the outbox while another run is in flight (could deliver a digest that then failed to confirm)
- Panel closes on Escape; removed the dangling `sourceMappingURL` reference to a map file that is not shipped
- README (zh/en) documents the timezone semantics: schedule follows the machine clock, digest title date is Beijing time (UTC+8)
## 0.3.5 - 2026-08-24

Fixes found in a full live pass against the dsh web profile.

- `/api/status` reported the outbox date as "today": a stale unconfirmed outbox (e.g. left overnight) made every poller see yesterday's date, and during a regenerate the field briefly fell back to the last sent date. `today` is now computed locally (same clock the scheduler uses) and the digest's own date is exposed as `digestDate`
- Agent tool `deliver` no longer re-sends a stale overnight outbox digest as if it were today's news (tells you to `run` first instead)
- Run-state `phaseDetail` no longer lingers (as a stale `{'delivered': true}`) after a run finishes
- The in-chat broadcast poller pauses while its tab is hidden, like the panel and settings card already did
## 0.3.4 - 2026-08-23

- README now defaults to Chinese (GitHub & npm landing page); the English version moved to README.en.md


## 0.3.3 - 2026-08-23

- Replace the README screenshot with a true-scale desktop viewport capture (the previous one was taken from a half-width region at 2x, so it read as zoomed-in)


## 0.3.2 - 2026-08-23

Mobile & robustness pass.

- Phone-width layout: the panel opens near-fullscreen (dynamic-viewport aware), the settings grid collapses to a single column, delivery-target rows wrap their key fields below the select, and the conversation-header button drops its text label
- Touch: all buttons get >=36px touch targets on coarse pointers; inputs render at 16px to stop iOS Safari's focus auto-zoom
- Digest lines wrap long tokens (`overflow-wrap:anywhere`) so nothing overflows on narrow screens
- Robustness: every panel action (get/regenerate, save config, save sources) now catches network errors and shows them in the UI instead of failing silently; fetches time out after 20s instead of hanging on flaky mobile networks
- Battery: status polling pauses while the tab is hidden (panel and settings card)
- Defensive normalization of `targets` in the settings form; modal exposes `role="dialog"`


## 0.3.1 - 2026-08-23

- Fix the digest disappearing right after midnight: the browser-side date vs server-reported "today" comparison could diverge across the day boundary and suppress the current digest; the digest now shows whenever it exists (its own date is in the title, and a newer digest replaces it automatically)

## 0.3.0 - 2026-08-22

- The in-chat digest now renders as a genuine model reply: it mounts at the end of the host message column (inheriting exact width, indentation and message spacing), drops the card header/emoji/bold tags, and keeps only host-style muted action buttons
- Fallback to composer-seat placement only if the message column cannot be located after sustained retries

## 0.2.2 - 2026-08-22

- Fix the in-chat digest never appearing after startup on a blank conversation: the mount point now keeps looking for a populated conversation instead of giving up after 10 s, and re-mounts when the host node is detached by a conversation switch

## 0.2.1 - 2026-08-22

Stability fixes.

- Keep the in-chat digest broadcast out of blank conversations so the composer remains visible
- Emit a valid object JSON Schema for `rss_daily` when `@deepseek-ai/dsh-tools` cannot be resolved from a linked installation
- Add offline regression tests for the broadcast policy and tool schema
- Split deterministic unit tests from the network-dependent delivery smoke test

## 0.1.0 - 2026-08-22

Initial release.

- 46 curated sources across tech / science / world / finance / humanities / dev
- Two-phase pipeline: fetch -> editorial pass -> confirm; idempotent delivery with outbox
- Editorial pass via `ctx.llm` (your existing dsh model) with a deterministic rule-based fallback
- Webhook targets: ServerChan / PushDeer / WeCom / Telegram / Bark / gotify / custom JSON
- 14-day dedup window, per-source health tracking, catch-up on boot (missed < 12 h)
- `rss_daily` agent tool (`run` / `status` / `redo` / `deliver`)
