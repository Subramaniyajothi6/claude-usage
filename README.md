# Claude Usage (VS Code)

A tiny **status bar** readout of your Claude Code usage limits — current
**5-hour session** and **weekly** quota — always visible at the bottom of VS
Code. Mirrors the numbers from Claude Code's `/usage` view.

```
✳ CS 17% - 3h | WS 7% - 3d
```

`CS` = current session, `WS` = weekly. The `- 3h` / `- 3d` is the time until
each limit resets. Hover the item for full bars and exact reset times; click it
to refresh now.

> **Not affiliated with Anthropic.** This is an unofficial community tool. It
> reads your existing Claude Code login and Anthropic's own usage API — nothing
> more.

## Screenshots

| Status bar | Hover tooltip |
| --- | --- |
| ![Status bar item](media/screenshots/statusbar.png) | ![Tooltip with bars and trends](media/screenshots/tooltip.png) |

The detailed split-terminal view:

![Detailed terminal view](media/screenshots/terminal.png)

> _Capturing these:_ in VS Code, use **Win+Shift+S** to snip the status bar
> item and its tooltip, save the PNGs into `media/screenshots/` with the names
> above. They'll then appear here and on the Marketplace listing.

## Features

- **Always-visible** session + weekly usage in the status bar, with time until
  each resets.
- **Hover tooltip** with progress bars, exact reset times, per-model (Opus /
  Sonnet) weekly usage, pay-as-you-go credits, and **trend sparklines**.
- **Notifications** when you cross 80% / 90% (configurable).
- **Detailed terminal view** you can split beside the Claude terminal.
- Color-coded: blue → yellow at 75% → red at 90%.

## How it works

- Reads your OAuth access token from `~/.claude/.credentials.json` (the file
  Claude Code already manages — there's no separate login).
- Polls `https://api.anthropic.com/api/oauth/usage` (the same endpoint `/usage`
  uses) every 10 minutes and shows `five_hour` and `seven_day` utilization.
- The token is re-read from disk on each poll, so it stays valid as long as
  Claude Code keeps refreshing it.
- Results are cached to a temp file so reloads don't trigger extra requests,
  and a 429 (rate limit) backs off automatically up to 30 minutes.

**Privacy:** nothing is sent anywhere except the usage request to Anthropic's
own API. The token is read from disk and used only for that request; it is
never stored or transmitted elsewhere. The temp cache stores only the
percentage/reset numbers, not your token.

> This relies on an **undocumented** endpoint, so it could change or break
> without notice.

## Extra: detailed view

There's also a detailed, `htop`-style bars view you can split beside your Claude
terminal — run **"Claude Usage: Open Detailed View Beside Terminal"** from the
Command Palette, or pick **Claude Usage** from the terminal split dropdown.

## Develop

1. Open this folder in VS Code, press **F5** (or run
   `code --extensionDevelopmentPath="<this folder>"`).
2. The usage appears in the bottom-right status bar.

## Test

```sh
npm install
npm test               # unit + mocked-network tests (fast, no VS Code)
npm run test:integration   # launches VS Code, checks activation/commands
npm run lint
```

## Package / install

```sh
npm i -g @vscode/vsce
vsce package                       # builds claude-usage-<version>.vsix
code --install-extension claude-usage-*.vsix
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeUsage.refreshIntervalSeconds` | `600` | Poll interval (min 60s; endpoint is rate-limited). |
| `claudeUsage.credentialsPath` | `""` | Override path to `.credentials.json`. |
| `claudeUsage.notifyAt` | `[80, 90]` | Warn when session/weekly usage crosses these %. `[]` to disable. |
| `claudeUsage.autoRefreshToken` | `false` | Renew an expired token and write it back to `.credentials.json`. Off by default so the extension never modifies your login file. |
