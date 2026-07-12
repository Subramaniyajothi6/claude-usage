# Changelog

All notable changes to **Claude Usage** are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.7.0] — 2026-07-12

### Added
- **Live context window (`CTX x%`)** — the active Claude Code chat's
  context-window fill in the status bar, with tokens / window size / model in
  the tooltip. Read locally from `~/.claude/projects` transcripts — zero extra
  API calls. Shows `CTX —` when no chat has been active in the last 30 min.
- **Multi-chat support** — `CTX 42% +1` when several chats are active; the
  tooltip lists each chat (named by its first message) with its own bar.
  Chats started in subfolders of the workspace are detected too.
- **Pick chat to track** — pin the status bar to a specific chat
  (*Claude Usage: Pick Chat to Track*), or let it auto-follow the newest.
- **Resume closed chats** — reopen any chat from the last 24 hours in a new
  terminal via `claude --resume` (*Claude Usage: Resume Recent Chat*, or the
  terminal icon next to any chat in the tooltip).
- **Context alert** — warning when a chat crosses 80% of its window
  (`claudeUsage.contextNotifyAt`), so you can `/compact` before auto-compact.
- **Daily stats** — today's total tokens and estimated API-price value with a
  per-model breakdown in the tooltip (`claudeUsage.showDailyStats`).
- **Window auto-detection by model family** — 200k / 500k / 1M defaults, with
  `claudeUsage.contextWindowTokens` as an explicit override.

### Fixed
- Context detection on Windows when VS Code reports a lowercase drive letter.

## [0.5.0] — 2026-06-06

### Added
- **Status bar readout** — always-visible `CS x% - 3h | WS y% - 3d`
  (current session % and weekly % with time until each resets).
- **Rich tooltip** — progress bars, exact reset times, per-model weekly usage
  (Opus / Sonnet), and pay-as-you-go credit spend when available.
- **Usage sparklines** — session and weekly trend lines in the tooltip, built
  from a rolling local history.
- **Threshold notifications** — warns when session or weekly usage crosses
  configurable percentages (default 80% and 90%), once per reset window.
- **Click feedback** — spinner while refreshing and a clear toast when
  rate-limited, instead of a silent no-op.
- **Detailed terminal view** — an `htop`-style bars view you can split right
  beside the Claude terminal.
- **Opt-in token refresh** (`claudeUsage.autoRefreshToken`, off by default) —
  renews an expired token and writes it back to `.credentials.json`.

### Behaviour
- Polls Anthropic's usage endpoint every 10 minutes (configurable, min 60s).
- Caches the last result and history locally so reloads don't trigger extra
  requests; backs off automatically (up to 30 min) on rate limits.
- Distinct, actionable states for signed-out / rate-limited / offline.

[0.7.0]: https://github.com/Subramaniyajothi6/claude-usage/releases/tag/v0.7.0
[0.5.0]: https://github.com/Subramaniyajothi6/claude-usage/releases/tag/v0.5.0
