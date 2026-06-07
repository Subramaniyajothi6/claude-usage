# Changelog

All notable changes to **Claude Usage** are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

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

[0.5.0]: https://github.com/Subramaniyajothi6/claude-usage/releases/tag/v0.5.0
