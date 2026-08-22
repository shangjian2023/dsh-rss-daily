# Changelog

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
