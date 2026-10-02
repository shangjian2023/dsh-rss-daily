# Changelog

## 0.7.0 - 2026-10-02

Audit-driven hardening: a four-agent audit (with an adversarial verifier) confirmed the happy path but found 3 blockers, 9 highs and 21 mediums in the seams — platform/version gaps, silent catches, and a release chain that had bypassed its own gates since 0.3.4. This release fixes all blockers, all highs, and every actionable medium; ships with regression tests for each; and restores the tag-driven release pipeline with provenance.

**Blockers**

- **Windows machines where only the `py` launcher exists now work at all**: `-3` was appended *after* the script path, argparse rejected it (`unrecognized arguments: -3`, exit 2) and every stage failed. Args are now `py -3 daily.py …` (audit B3)
- **`except TimeoutError` couldn't catch `concurrent.futures.TimeoutError` on Python 3.9/3.10** (it only aliases the builtin since 3.11) — a few slow sources together would crash the whole fetch. Both catch sites fixed + regression test (audit B2)
- **The MCP server no longer fails to start on current mcp releases**: `mcp.server.fastmcp` is gone in mcp 2.x; the import now falls back to `MCPServer`. Handshake verified against mcp 2.2.0 (initialize + tools/list, all 4 tools) (audit B1)

**Delivery correctness (no more duplicate digests)**

- `--stage status` and `--stage confirm` no longer take the exclusive lock. Previously, a concurrent fetch (MCP, cron, another profile) made status return `LOCKED` — the JS side compared `undefined === undefined` and reported "already delivered today" — and confirm's `LOCKED` (rc 0) was swallowed as success, so the idempotency gate never got written and the *same digest was re-delivered next round*. status is pure file reads; confirm only writes via atomic replace (audit H3/H9/M7/M-1, verified end-to-end under a held lock)
- One malformed delivery target (missing `type`) used to crash the whole delivery round — targets that *had* received the digest couldn't be confirmed and got it again the next day. Malformed targets are now filtered at config load, per-target failures don't reject the batch, and unknown types don't retry (audit H2)
- Lock file is opened `a+` (no longer truncates the holder's PID) and is never deleted on exit, closing the unlink-race double-hold window (audit M11)
- The MCP side's `_running()` probe now *try-locks* instead of reading the lock file — Windows `LockFile` makes the locked byte range unreadable (`PermissionError`), so during any external fetch it always reported "not running" (audit H6). MCP also honors `RSS_DAILY_TZ` so it and the plugin agree on what "today" means (audit M16)

**Security**

- API write routes (`run/redo/redeliver/config/sources`) require same-origin (`Origin`/`Sec-Fetch-Site`) **and** `Content-Type: application/json` — a cross-site "simple request" (no CORS preflight) could previously rewrite your delivery targets to an attacker webhook (audit H1)
- `fetch_page_text` only fetches `http`/`https`: a poisoned feed could point the enricher at `file:///` (local file read into the LLM prompt) or `data:` (arbitrary injection) (audit H4)
- TLS-downgrade retry no longer applies to credentialed requests: the LLM direct call used to re-send `Authorization: Bearer <key>` over a channel with `CERT_NONE` + no hostname check whenever the first handshake failed — a classic on-path key harvest (audit H5)
- Self-drawn links in the panel/broadcast get the same `http(s)`-only `sanitizeUrl` the host's MarkdownText applies (audit M6); the one plaintext-HTTP source (arXiv) moved to https

**No more silent data loss**

- A corrupt `panel-config.json` is moved aside with a warning instead of being silently ignored (the next save used to overwrite all your settings with defaults), persist failures now surface to the API instead of `saved:true`, and a broken `sources.json` returns a 500 instead of an empty list that one save would turn into "0 sources" (audit M8/M9/M10)
- Masked-secret backfill matches targets by type identity instead of array index — a stale panel snapshot could bake the literal `•••` into the config as a "secret" forever; unmatched masks are now rejected (audit M2)
- `footer` is capped at 500 chars: one oversized footer made every run die with `spawn ENAMETOOLONG` and never self-heal (audit M3)
- The in-chat broadcast card no longer vanishes ~20 s after appearing (an 800 ms loop unconditionally cleared the view state); it now clears only when the conversation actually changes (audit M1)

**Editorial quality**

- `time.mktime` → `calendar.timegm`: feedparser timestamps are UTC and were shifted −8 h on UTC+8 hosts, systematically burying fresh news in the recency tiers (audit M12)
- LLM reply parsing scans JSON objects left-to-right instead of a greedy `{.*}` match — a stray example object in the reply no longer silently discards the entire edit (audit M18)
- Rule-mode digests honor `--lang` (the title said 每日要闻 in English digests), one-liners for English use a 200-char budget instead of being cut mid-word at 50 (audit M14/M15); enricher respects charset headers/meta instead of force-decoding UTF-8 (GBK sources became U+FFFD) (audit M13); translate fallback keeps your configured provider (audit M4); all-disabled sources return empty instead of crashing `pick_sources` (audit M17); `record()`/`load_json()` tolerate damaged state files (audit F-PY-15/18)

**Engineering / release chain**

- Release gates restored: tags v0.4.0–v0.6.2 are backfilled, publishing goes through `release.yml` again (pytest + unit + smoke + tarball assertions + `--provenance`), and `files` is an explicit list — the npm tarball no longer ships `mcp/__pycache__/*.pyc` (audit H7/H8/M19)
- CI runs on pnpm with a committed lockfile, Node 22/24 (matching the host's own engines), includes the smoke E2E and a tarball content assertion, plus a client-bundle contract test (audit M20/M21/F-PKG-05)
- `test` scripts use a glob Node's test runner expands itself — no more shell-glob dependence that failed on Windows + Node 18/20 (audit F-PKG-12); engines raised to `>=22.19.0` (audit F-PKG-09); docs synced (API endpoint list, source categories, lead tolerance, mcp version note, platform note for the 420 s budget)


## 0.6.2 - 2026-09-30

Context footprint + broadcast frequency, both user-reported.

- **The rss_daily agent tool is now opt-in (default off)**. Evidence from live sessions: the digest text never enters context (broadcast stays frontend-only), but the tool *definition* sits in every conversation's request header (~90 tokens) — and on DSH Desktop it only started doing so once 0.6.1 fixed the schema the old host rejected, which read as "the plugin occupies context again". Flip `agentTool` on in Settings if you want the model to drive the digest; the panel and the MCP sidecar cover the same ground without touching any conversation
- **The in-chat broadcast now shows once per digest**: starting the reveal marks the digest as seen (only while the page is actually visible), so a new conversation — or switching conversations — no longer replays it. A fresh digest (next day, or after an explicit regenerate) shows once again. "Hide for today" and the panel-triggered unhide keep working; the current view keeps the card until you move on
- Settings tab gains an agent-tool toggle next to the broadcast toggle


## 0.6.1 - 2026-09-30

Bugfix sweep after the first Desktop run of 0.6.0.

- **Settings tab no longer freezes the app**: `SettingsForm` kept a `useState` *after* its `draft` early-return — hook count changed between renders, React threw "Rendered more hooks" and, with no error boundary, took the whole host UI down. Hook moved above the early return (0.5.0-era bug, now also guarded by a source-level regression test)
- **English digest, round 2 — fixed for real**: 0.6.0 passed `node:fs/promises` into a receipts module calling `readFileSync` — every LLM call threw before even reaching the model, so both the edit pass and the translate fallback died silently and rule mode won again. The receipts module now imports `node:fs` directly (the unit test had masked this by passing sync fs)
- **Stale-box self-heal**: a pending outbox left in rule mode by a broken run (e.g. a schedule firing on crashed code) used to be reused forever — now the next run translates the rule picks in place instead of re-fetching everything; the budget breaker keeps it from repeating
- An unparseable LLM reply (finalize falls back to rule internally) now also enters the salvage chain instead of shipping rule output silently
- Receipts date bucket switched from UTC to local, matching the scheduler's day boundary
- All plugin surfaces (panel, settings card, in-chat broadcast) are wrapped in an error boundary — a future render crash shows a one-line reason instead of blanking the app


## 0.6.0 - 2026-09-30

Desktop-host adaptation + editorial pipeline distilled from [AIHOT](https://github.com/KKKKhazix/AIHOT) (卡神's open-source hot-news framework). The plugin stays a plugin — no Postgres, no worker fleet — but adopts AIHOT's editorial discipline where it pays off.

**Why: on DSH Desktop 2.0.16 the digest came out in raw English and the panel was transparent.**

- Root cause 1 (English): the LLM edit step silently fell back to rule mode — thinking models (qwen3.7-plus via relay) burned the whole 900-token budget on reasoning and returned empty content ("empty llm reply", host log 2026-09-29 19:51). Fixes:
  - Default model now follows the host's `agentDefaultModel` selection (the model you chat with) instead of gambling on `listProviders()[0]`, which could land on a credential-less route on Desktop
  - `maxTokens` default 900 → 3072, with an automatic one-shot retry at doubled budget on empty replies
  - Translate salvage: if the edit call still fails, the rule-picked items go through a cheap translation-only LLM pass so the digest language never degrades (AIHOT: selection may fall back, writing must not)
  - Honest degradation: when even that fails, the digest carries an explicit "raw titles" note and the panel badges it in warning color instead of passing English off as normal
  - Every paid call is receipted to `stateDir/llm-receipts.json` with a daily call budget (8/day) so retries can never run away (AIHOT receipts + budget breaker)
- Root cause 2 (transparent panel): the client bundle renamed/removed the `--dsw-*` variables the panel borrowed (`--dsw-alias-fill-l1`, `--dsw-shadow-lv3` gone; `--dsw-specific-menu` now indirected). The panel now ships its own self-contained design system: opaque light/dark palettes, theme decided by sampling the host surface luminance when the panel opens. The in-chat broadcast keeps using the host's native MarkdownText — it lives inside the message column where host styles still apply
- Editor prompt distilled from AIHOT's prompt suite: five-axis private scoring with a noise-suppression table, answer-first one-liners, self-contained titles (subject must be named), anti-hallucination rules (no invented numbers/versions, relative dates copied as-is, no "first/largest/only"), plus an optional `lead` line summarizing the day (shown in panel and broadcast)
- New-host compatibility: agent tool schema no longer trips the stricter 0.2.0-rc validator (`required: false` at property level is rejected); when the host has no `settings.register()` (DSH Desktop), panel-saved config persists to `stateDir/panel-config.json` and reloads as an overlay on startup — config always has a home
- Panel digest tab restyled as a hot list: status chips (delivered / AI-edited / translated / raw), lead paragraph, per-item corroboration badges (✚N家 for cross-verified events)
- `llmMaxTokens` is now editable in the settings tab

## Unreleased

- New: MCP server (`mcp/server.py`) exposes the pipeline as MCP tools — `rss_status` / `rss_fetch` / `rss_finalize` / `rss_confirm` — so Claude Code, Codex, opencode and any other MCP client can drive the digest interactively; the host agent acts as editor and delivery channel, and the state directory is shared with the dsh plugin (idempotency + fetch locking). Long fetches return `RUNNING` after a short inline wait and are polled via `rss_status`. Windows note: child processes must be spawned with `stdin=DEVNULL` — inheriting the MCP stdio pipe delays child exit by seconds

## 0.5.0 - 2026-08-26

- Digest language setting (zh | en): editor prompt, one-liners and title follow it; English tag vocabulary (AI/Tech/World/…) with matching panel colors
- Digest timezone setting (UTC+8 / UTC-5 / UTC+5:30): digest dates and day boundaries no longer assume Beijing time
- Delivery transparency: per-target last outcome (ok/attempts) is recorded and shown next to each target, with a "retry failed targets" action that redelivers only what failed
- First-run onboarding card in the panel when no delivery target is configured
- Sources import/export (JSON) in the Sources tab — share or back up your tuned source list
- Release workflow: npm publish with provenance on tag push (needs NPM_TOKEN secret)

## 0.4.1 - 2026-08-24

- Clicking **Get today's digest** or **Regenerate** in the panel now lifts a same-day "Hide for today": an explicit request is intent to see the digest, so the in-chat broadcast reappears (and plays its typing reveal) instead of staying suppressed until midnight

## 0.4.0 - 2026-08-24

The in-chat broadcast now IS a model reply, visually.

- Digest body renders through the host's own `MarkdownText` component (statically available from `@deepseek-ai/dsh-client-ui-primitives`) — the exact component, CSS, link styling and list rendering behind genuine assistant messages, instead of a hand-copied markdown imitation
- New-digest reveal plays a typing cadence: the text streams in prefix-by-prefix in streaming render state with the action row hidden until done, exactly like a message being generated; `prefers-reduced-motion` skips straight to the full text
- Native copy affordance: a Copy action (host clipboard helper + host icon) joins the action row; older browsers/hosts without the primitives module fall back to the previous hand-rolled rendering
- A page loaded in a background tab no longer leaves the broadcast stuck empty — visibility changes fast-forward an unfinished reveal to the full text
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
