const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CLEAR,
  GRAY,
  RESET,
  relReset,
  absReset,
  tooltipBar,
  buildFrame,
  errorFrame,
  statusText,
  backoffMs,
  newlyCrossed,
  sparkline,
} = require("./lib");

const api = require("./api");
const ctx = require("./context");

// ---- credentials + fetch -------------------------------------------------

function credentialsPath() {
  const override = vscode.workspace
    .getConfiguration("claudeUsage")
    .get("credentialsPath");
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

// Tagged error so the UI can show a precise, actionable state.
class UsageError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "signedOut" | "rateLimited" | "network" | "unknown"
  }
}

function readCredentials() {
  const p = credentialsPath();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    throw new UsageError("signedOut", "No Claude credentials file found.");
  }
  let json;
  try {
    json = JSON.parse(raw) || {};
  } catch {
    throw new UsageError("signedOut", "Credentials file is unreadable.");
  }
  const oauth = json.claudeAiOauth || {};
  if (!oauth.accessToken) throw new UsageError("signedOut", "Not signed in to Claude.");
  return { path: p, json, oauth };
}

function writeCredentials(p, json) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
  fs.renameSync(tmp, p); // atomic-ish: don't leave a half-written creds file
}

// Refresh the access token and persist the rotated tokens back to the shared
// credentials file, so Claude Code keeps working too.
async function refreshAndPersist(p, json, oauth) {
  if (!oauth.refreshToken) throw new UsageError("signedOut", "No refresh token available.");
  const r = await api.refreshToken(oauth.refreshToken);
  oauth.accessToken = r.access_token;
  if (r.refresh_token) oauth.refreshToken = r.refresh_token;
  if (r.expires_in) oauth.expiresAt = Date.now() + r.expires_in * 1000;
  json.claudeAiOauth = oauth;
  writeCredentials(p, json);
  return oauth.accessToken;
}

/**
 * Return a valid access token, refreshing (and persisting) when expired.
 * Re-reads from disk every call so Claude Code's own refreshes are picked up.
 */
async function getValidToken() {
  const { path: p, json, oauth } = readCredentials();
  const SKEW = 60 * 1000;
  const expired = oauth.expiresAt && Date.now() > oauth.expiresAt - SKEW;
  if (expired && oauth.refreshToken && autoRefreshEnabled()) {
    return refreshAndPersist(p, json, oauth);
  }
  return oauth.accessToken;
}

// ---- disk cache (so reloads don't trigger a fresh fetch / rate limit) ----

const CACHE_FILE = path.join(os.tmpdir(), "claude-usage-cache.json");

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    /* ignore */
  }
}

// ---- usage history (for the tooltip sparkline) ---------------------------

const HISTORY_FILE = path.join(os.tmpdir(), "claude-usage-history.json");
const HISTORY_MAX = 48;

function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_MAX)));
  } catch {
    /* ignore */
  }
}

async function fetchUsage() {
  try {
    let token = await getValidToken();
    try {
      return await api.fetchUsage(token);
    } catch (e) {
      const msg = String(e.message || e);
      // Token rejected — force one refresh and retry (only if user opted in).
      if (msg.startsWith("401") || msg.startsWith("403")) {
        if (!autoRefreshEnabled()) {
          throw new UsageError(
            "signedOut",
            "Access token expired. Open Claude Code to refresh it, or enable claudeUsage.autoRefreshToken."
          );
        }
        const { path: p, json, oauth } = readCredentials();
        token = await refreshAndPersist(p, json, oauth);
        return await api.fetchUsage(token);
      }
      if (msg.startsWith("429")) throw new UsageError("rateLimited", msg);
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(msg))
        throw new UsageError("network", msg);
      throw new UsageError("unknown", msg);
    }
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError("unknown", String(e.message || e));
  }
}

function autoRefreshEnabled() {
  return vscode.workspace
    .getConfiguration("claudeUsage")
    .get("autoRefreshToken", false);
}

function configInterval() {
  const secs = vscode.workspace
    .getConfiguration("claudeUsage")
    .get("refreshIntervalSeconds", 600);
  return Math.max(60, secs) * 1000;
}

// ---- context window (local transcript read, no network) -------------------

const CTX_POLL_MS = 15000; // cheap local file read
const CTX_STALE_MS = 30 * 60 * 1000; // hide from status bar after 30 min idle

function ctxConfig() {
  const cfg = vscode.workspace.getConfiguration("claudeUsage");
  return {
    show: cfg.get("showContextWindow", true),
    windowOverride: cfg.get("contextWindowTokens", 0),
    notifyAt: cfg.get("contextNotifyAt", [80]),
  };
}

// Every recently-active chat across all workspace folders, newest first.
function readWorkspaceSessions(activeMs = CTX_STALE_MS) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return [];
  const { windowOverride } = ctxConfig();
  let all = [];
  for (const f of folders) {
    try {
      all = all.concat(
        ctx.activeSessions(f.uri.fsPath, { windowOverride, activeMs })
      );
    } catch {
      /* folder without transcripts */
    }
  }
  return all.sort((a, b) => b.lastActivity - a.lastActivity);
}

// Reopen a chat in a fresh terminal via `claude --resume <session-id>`.
function resumeInTerminal(session) {
  const folders = vscode.workspace.workspaceFolders;
  const cwd = session.cwd || (folders && folders.length ? folders[0].uri.fsPath : undefined);
  const term = vscode.window.createTerminal({
    name: session.label ? session.label.slice(0, 24) : "Claude",
    cwd,
  });
  term.show();
  term.sendText(`claude --resume ${session.sessionId}`, true);
}

// ---- pseudoterminal (detailed bars view) ---------------------------------

class UsageTerminal {
  constructor() {
    this.cols = 60;
    this.writeEmitter = new vscode.EventEmitter();
    this.timer = undefined;
    this.last = null;

    this.pty = {
      onDidWrite: this.writeEmitter.event,
      open: (dims) => {
        if (dims) this.cols = dims.columns;
        // Hard reset (incl. scrollback) once, to wipe any revived content.
        this.write(CLEAR);
        const cached = loadCache();
        if (cached && cached.data) {
          this.last = cached.data;
          this.lastFetch = cached.fetchedAt;
          this.updatedAt = new Date(cached.fetchedAt).toLocaleTimeString();
          this.render();
        } else {
          this.write(GRAY + "\r\nLoading Claude usage…" + RESET);
        }
        this.startPolling();
        const age = Date.now() - (cached ? cached.fetchedAt : 0);
        if (!cached || age > this.baseInterval) this.refresh();
        else this.scheduleNext(this.baseInterval - age);
      },
      close: () => this.stopPolling(),
      setDimensions: (dims) => {
        this.cols = dims.columns;
        this.render();
      },
      handleInput: (d) => {
        if (d === "r" || d === "R" || d === "\r") this.refresh();
      },
    };
  }

  write(s) {
    this.writeEmitter.fire(s);
  }

  startPolling() {
    this.stopPolling();
    this.baseInterval = configInterval();
    this.scheduleNext(this.baseInterval);
    this.tick = setInterval(() => this.render(), 30000);
  }

  scheduleNext(delay) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), delay);
  }

  stopPolling() {
    if (this.timer) clearTimeout(this.timer);
    if (this.tick) clearInterval(this.tick);
    this.timer = this.tick = undefined;
  }

  async refresh() {
    const now = Date.now();
    if (this.inFlight) return;
    if (now - (this.lastFetch || 0) < 5000) {
      this.scheduleNext(5000);
      return;
    }
    this.inFlight = true;
    this.lastFetch = now;
    try {
      this.last = await fetchUsage();
      saveCache(this.last);
      this.updatedAt = new Date().toLocaleTimeString();
      this.errorCount = 0;
      this.note = "";
      this.render();
      this.scheduleNext(this.baseInterval);
    } catch (err) {
      this.errorCount = (this.errorCount || 0) + 1;
      const msg = String(err.message || err);
      const backoff = backoffMs(this.errorCount);
      if (this.last) {
        this.note = msg.startsWith("429")
          ? `rate limited — retrying in ${Math.round(backoff / 1000)}s`
          : `error: ${msg.slice(0, 40)} — retrying in ${Math.round(backoff / 1000)}s`;
        this.render();
      } else {
        this.write(errorFrame(msg));
      }
      this.scheduleNext(backoff);
    } finally {
      this.inFlight = false;
    }
  }

  render() {
    if (this.last)
      this.write(buildFrame(this.last, this.cols, this.updatedAt, this.note));
  }
}

// ---- status bar (always-visible readout) ---------------------------------

class StatusController {
  constructor(context) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "claudeUsage.refresh";
    this.item.text = "$(sync~spin) $(claude-logo) Claude usage";
    this.item.tooltip = "Loading Claude usage…";
    this.item.show();
    context.subscriptions.push(this.item, { dispose: () => this.stop() });

    this.errorCount = 0;
    this.history = loadHistory();
    this.firedCS = 0;
    this.firedWS = 0;
    const c = loadCache();
    if (c && c.data) {
      this.last = c.data;
      this.fetchedAt = c.fetchedAt;
      this.render();
    }
    const age = Date.now() - (c ? c.fetchedAt : 0);
    if (!c || age > configInterval()) this.poll();
    else this.schedule(configInterval() - age);

    // Context window: local file read, so it can poll much faster than the API.
    this.ctxFired = 0;
    this.ctxSession = null;
    this.sessions = [];
    this.pinnedId = null; // null = auto-track the newest chat
    this.pollContext();
    this.ctxTimer = setInterval(() => this.pollContext(), CTX_POLL_MS);
  }

  schedule(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.nextRetryAt = Date.now() + ms;
    this.timer = setTimeout(() => this.poll(), ms);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.ctxTimer) clearInterval(this.ctxTimer);
    this.timer = this.ctxTimer = undefined;
  }

  pollContext() {
    // Daily stats piggyback on this timer; the per-file cache in context.js
    // means only transcripts that changed since last tick get re-parsed.
    if (
      vscode.workspace.getConfiguration("claudeUsage").get("showDailyStats", true)
    ) {
      try {
        this.today = ctx.todayStats();
      } catch {
        this.today = null;
      }
    } else {
      this.today = null;
    }
    const { show, notifyAt } = ctxConfig();
    const prev = this.ctx;
    this.sessions = show ? readWorkspaceSessions() : [];
    // Track the pinned chat while it's still active, otherwise the newest.
    this.ctx =
      (this.pinnedId && this.sessions.find((s) => s.sessionId === this.pinnedId)) ||
      this.sessions[0] ||
      null;
    if (!this.ctx) {
      if (prev) this.render();
      return;
    }
    // New chat or a /compact (big token drop) re-arms the notification.
    if (
      this.ctx.sessionId !== this.ctxSession ||
      (prev && this.ctx.sessionId === prev.sessionId && this.ctx.tokens < prev.tokens * 0.7)
    ) {
      this.ctxSession = this.ctx.sessionId;
      this.ctxFired = 0;
    }
    if (Array.isArray(notifyAt) && notifyAt.length) {
      const hit = newlyCrossed(this.ctx.pct, notifyAt, this.ctxFired);
      if (hit !== null) {
        this.ctxFired = hit;
        const who = this.ctx.label ? ` ("${this.ctx.label}")` : "";
        vscode.window.showWarningMessage(
          `Claude chat${who} context at ${this.ctx.pct}% of its window — consider /compact before it auto-compacts.`
        );
      }
    }
    if (
      !prev ||
      prev.sessionId !== this.ctx.sessionId ||
      prev.tokens !== this.ctx.tokens ||
      (this.sessions.length > 1) !== this.hadMulti
    ) {
      this.hadMulti = this.sessions.length > 1;
      this.render();
    }
  }

  // QuickPick to pin which chat the status bar tracks.
  async pickSession() {
    const items = [
      {
        label: "$(sync) Auto — newest chat",
        description: this.pinnedId ? "" : "current",
        id: null,
      },
      ...this.sessions.map((s) => ({
        label: `$(comment-discussion) ${s.label || s.sessionId.slice(0, 8)}`,
        description: `${s.pct}% · ${ctx.fmtTokens(s.tokens)} tokens · ${ctx.agoLabel(s.lastActivity)}`,
        detail: s.sessionId === (this.ctx && this.ctx.sessionId) ? "currently shown" : undefined,
        id: s.sessionId,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Which Claude Code chat should the status bar track?",
    });
    if (!pick) return;
    this.pinnedId = pick.id;
    this.pollContext();
    this.render();
  }

  // QuickPick over the last 24h of chats — reopen one whose terminal was
  // closed (or open a second view on a running one) via `claude --resume`.
  async resumeChat() {
    const sessions = readWorkspaceSessions(24 * 60 * 60 * 1000);
    if (!sessions.length) {
      vscode.window.showInformationMessage(
        "No Claude Code chats found for this workspace in the last 24 hours."
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: `$(comment-discussion) ${s.label || s.sessionId.slice(0, 8)}`,
        description: `${s.pct}% · ${ctx.fmtTokens(s.tokens)} tokens · ${ctx.agoLabel(s.lastActivity)}`,
        session: s,
      })),
      { placeHolder: "Reopen which chat? (runs `claude --resume` in a new terminal)" }
    );
    if (pick) resumeInTerminal(pick.session);
  }

  // Manual refresh (status bar click) — always gives the user feedback.
  refresh() {
    if (this.inFlight) {
      vscode.window.setStatusBarMessage("$(sync~spin) Claude usage: refreshing…", 2000);
      return;
    }
    if (this.errorState && this.nextRetryAt && Date.now() < this.nextRetryAt) {
      const secs = Math.round((this.nextRetryAt - Date.now()) / 1000);
      const wait = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
      vscode.window.showWarningMessage(
        `Claude usage: ${this.note || this.errorState} — next retry in ${wait}.`
      );
      return;
    }
    this.poll();
  }

  async poll() {
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastFetch = Date.now();
    // Spinner feedback while fetching.
    this.item.text = this.last
      ? `$(sync~spin) ${statusText(this.last).text}`
      : "$(sync~spin) $(claude-logo) Claude usage";
    try {
      this.last = await fetchUsage();
      this.fetchedAt = Date.now();
      saveCache(this.last);
      this.errorCount = 0;
      this.errorState = null;
      this.note = "";
      this.recordSample();
      this.maybeNotify();
      this.render();
      this.schedule(configInterval());
    } catch (err) {
      this.errorCount += 1;
      this.errorState = err.kind || "unknown";
      this.note =
        this.errorState === "rateLimited"
          ? "rate limited"
          : this.errorState === "signedOut"
          ? "not signed in"
          : this.errorState === "network"
          ? "offline"
          : "error";
      this.render();
      // Signed-out won't fix itself by retrying fast; back off long.
      const delay =
        this.errorState === "signedOut"
          ? 10 * 60 * 1000
          : backoffMs(this.errorCount);
      this.schedule(delay);
    } finally {
      this.inFlight = false;
    }
  }

  recordSample() {
    const s = statusText(this.last);
    this.history.push({ t: this.fetchedAt, fh: s.fh, sd: s.sd });
    if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX);
    saveHistory(this.history);
  }

  maybeNotify() {
    const thresholds = vscode.workspace
      .getConfiguration("claudeUsage")
      .get("notifyAt", [80, 90]);
    if (!Array.isArray(thresholds) || thresholds.length === 0) return;
    const s = statusText(this.last);

    // Reset the "already fired" marker when a window rolls over.
    const csReset = (this.last.five_hour || {}).resets_at;
    const wsReset = (this.last.seven_day || {}).resets_at;
    if (csReset !== this.csResetKey) {
      this.csResetKey = csReset;
      this.firedCS = 0;
    }
    if (wsReset !== this.wsResetKey) {
      this.wsResetKey = wsReset;
      this.firedWS = 0;
    }

    const csHit = newlyCrossed(s.fh, thresholds, this.firedCS);
    if (csHit !== null) {
      this.firedCS = csHit;
      vscode.window.showWarningMessage(
        `Claude session usage at ${s.fh}% — ${relReset(csReset)}.`
      );
    }
    const wsHit = newlyCrossed(s.sd, thresholds, this.firedWS);
    if (wsHit !== null) {
      this.firedWS = wsHit;
      vscode.window.showWarningMessage(
        `Claude weekly usage at ${s.sd}% — ${absReset(wsReset)}.`
      );
    }
  }

  render() {
    // Signed-out (or no creds): show a muted, actionable item.
    if (this.errorState === "signedOut" && !this.last) {
      this.item.text = "$(claude-logo) Claude: sign in";
      this.item.backgroundColor = undefined;
      this.item.tooltip =
        "Not signed in to Claude Code. Open Claude Code and log in, then click to retry.";
      return;
    }
    if (!this.last) return;
    const s = statusText(this.last);

    // Live chat context; "+N" flags other concurrently active chats.
    // Shows "CTX —" (instead of hiding) when no chat was active recently,
    // so the segment doesn't mysteriously appear and disappear.
    const c = this.ctx;
    const others = Math.max(0, (this.sessions || []).length - 1);
    const ctxSeg = !ctxConfig().show
      ? ""
      : c
      ? ` | CTX ${c.pct}%${others ? ` +${others}` : ""}`
      : " | CTX —";

    this.item.text = `$(claude-logo) ${s.text}${ctxSeg}`;
    this.item.backgroundColor =
      s.worst >= 90
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : s.worst >= 75
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`**Claude usage**\n\n`);
    if (this.last.five_hour) {
      md.appendMarkdown(`Current session — **${s.fh}%** used\n\n`);
      md.appendMarkdown(
        "`" + tooltipBar(s.fh) + "`  " + relReset(this.last.five_hour.resets_at) + "\n\n"
      );
    }
    if (this.last.seven_day) {
      md.appendMarkdown(`Weekly (all models) — **${s.sd}%** used\n\n`);
      md.appendMarkdown(
        "`" + tooltipBar(s.sd) + "`  " + absReset(this.last.seven_day.resets_at) + "\n\n"
      );
    }
    const modelRow = (label, obj) => {
      if (!obj) return;
      const p = Math.round(obj.utilization || 0);
      md.appendMarkdown(`${label} weekly — **${p}%**\n\n`);
      md.appendMarkdown("`" + tooltipBar(p) + "`  " + absReset(obj.resets_at) + "\n\n");
    };
    modelRow("Opus", this.last.seven_day_opus);
    modelRow("Sonnet", this.last.seven_day_sonnet);

    if (this.sessions && this.sessions.length) {
      const multi = this.sessions.length > 1;
      md.appendMarkdown(multi ? `**Active chats (${this.sessions.length})**\n\n` : "");
      for (const sess of this.sessions) {
        const tracked = c && sess.sessionId === c.sessionId;
        const name = sess.label || sess.sessionId.slice(0, 8);
        const marker = multi ? (tracked ? "$(pin) " : "$(comment) ") : "";
        const resumeUri = `command:claudeUsage.resumeSession?${encodeURIComponent(
          JSON.stringify([sess])
        )}`;
        md.appendMarkdown(
          `${marker}${multi ? name + " — " : "Chat context — "}**${sess.pct}%** ` +
            `(${ctx.fmtTokens(sess.tokens)} / ${ctx.fmtTokens(sess.windowSize)} tokens) ` +
            `[$(terminal)](${resumeUri} "Reopen this chat in a new terminal (claude --resume)")\n\n`
        );
        md.appendMarkdown(
          "`" +
            tooltipBar(sess.pct) +
            "`  " +
            (sess.model ? sess.model + " · " : "") +
            ctx.agoLabel(sess.lastActivity) +
            "\n\n"
        );
      }
      if (multi) {
        md.appendMarkdown(
          `_[Pick which chat to track](command:claudeUsage.pickSession)_ · `
        );
      }
      md.appendMarkdown(
        `_[$(history) Resume a recent chat](command:claudeUsage.resumeChat)_\n\n`
      );
      md.isTrusted = true;
    } else if (ctxConfig().show) {
      md.appendMarkdown(
        `Chat context — no chat active in the last 30 min\n\n` +
          `_[$(history) Resume a recent chat](command:claudeUsage.resumeChat)_\n\n`
      );
      md.isTrusted = true;
    }

    const xu = this.last.extra_usage;
    if (xu && xu.is_enabled) {
      const cur = xu.currency || "$";
      if (xu.used_credits != null && xu.monthly_limit != null) {
        md.appendMarkdown(
          `Pay-as-you-go — **${cur}${xu.used_credits}** / ${cur}${xu.monthly_limit}\n\n`
        );
      } else if (xu.utilization != null) {
        md.appendMarkdown(`Pay-as-you-go — **${Math.round(xu.utilization)}%**\n\n`);
      }
    }
    if (this.today) {
      md.appendMarkdown(
        `Today — **${ctx.fmtTokens(this.today.tokens)}** tokens · ` +
          `~$${this.today.cost.toFixed(2)} API value\n\n`
      );
      const byUse = Object.entries(this.today.models).sort(
        (a, b) => b[1].in + b[1].out + b[1].cr + b[1].cw - (a[1].in + a[1].out + a[1].cr + a[1].cw)
      );
      for (const [model, m] of byUse.slice(0, 3)) {
        md.appendMarkdown(
          `&nbsp;&nbsp;${model}: ${ctx.fmtTokens(m.out)} out · ` +
            `${ctx.fmtTokens(m.in + m.cr + m.cw)} in\n\n`
        );
      }
    }
    if (this.history && this.history.length >= 2) {
      const recent = this.history.slice(-24);
      md.appendMarkdown(
        `Session trend  \`${sparkline(recent.map((h) => h.fh))}\`\n\n`
      );
      md.appendMarkdown(
        `Weekly trend   \`${sparkline(recent.map((h) => h.sd))}\`\n\n`
      );
    }
    const updated = this.fetchedAt
      ? new Date(this.fetchedAt).toLocaleTimeString()
      : "—";
    md.appendMarkdown(
      `\n_updated ${updated}${this.note ? " · " + this.note : ""} · click to refresh_`
    );
    this.item.tooltip = md;
  }
}

// ---- activation ----------------------------------------------------------

function makeTerminal(beside) {
  const u = new UsageTerminal();
  const opts = { name: "Claude Usage", pty: u.pty };
  if (beside && vscode.window.activeTerminal) {
    opts.location = { parentTerminal: vscode.window.activeTerminal };
  }
  const term = vscode.window.createTerminal(opts);
  term.show();
  return term;
}

function activate(context) {
  const status = new StatusController(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsage.refresh", () => status.refresh()),
    vscode.commands.registerCommand("claudeUsage.pickSession", () => status.pickSession()),
    vscode.commands.registerCommand("claudeUsage.resumeChat", () => status.resumeChat()),
    vscode.commands.registerCommand("claudeUsage.resumeSession", (session) =>
      resumeInTerminal(session)
    ),
    vscode.commands.registerCommand("claudeUsage.openBeside", () => makeTerminal(true)),
    vscode.commands.registerCommand("claudeUsage.open", () => makeTerminal(false)),
    vscode.window.registerTerminalProfileProvider("claudeUsage.profile", {
      provideTerminalProfile() {
        const u = new UsageTerminal();
        return new vscode.TerminalProfile({ name: "Claude Usage", pty: u.pty });
      },
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
