# Changelog

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
