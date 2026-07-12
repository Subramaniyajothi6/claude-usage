// Context-window tracking for the active Claude Code chat.
//
// Claude Code writes every session transcript to
//   ~/.claude/projects/<sanitized cwd>/<session-id>.jsonl
// and each assistant message carries a `usage` block. The sum of
// input_tokens + cache_read_input_tokens + cache_creation_input_tokens on the
// *latest* assistant message is the current size of the chat's context.
// Everything here is plain fs — no network, no vscode module — so it can be
// unit-tested directly.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_WINDOW = 200000;
const TAIL_BYTES = 256 * 1024; // read only the tail of large transcripts

// Claude Code derives the project folder name by replacing every
// non-alphanumeric character of the workspace path with "-".
function projectDirName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function projectsRoot(claudeDir) {
  return path.join(claudeDir || path.join(os.homedir(), ".claude"), "projects");
}

// Project dirs that can belong to `cwd`: the exact match plus chats started in
// subfolders (a chat launched in D:\proj\src gets its own dir "D--proj-src").
// The name match can over-include siblings ("D:\proj two" also sanitizes to a
// "D--proj-two" prefix match), so callers verify against the transcript's own
// `cwd` field.
function projectDirsFor(cwd, claudeDir) {
  const root = projectsRoot(claudeDir);
  // Case-insensitive: VS Code reports "d:\..." while Claude Code names the
  // project dir from "D:\..." — same folder on Windows.
  const base = projectDirName(cwd).toLowerCase();
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      const ln = n.toLowerCase();
      return ln === base || ln.startsWith(base + "-");
    })
    .map((n) => path.join(root, n));
}

// Is `child` the same directory as `parent`, or inside it?
function isWithin(child, parent) {
  if (!child) return true; // older transcripts had no cwd field — accept
  const c = String(child).toLowerCase();
  const p = String(parent).toLowerCase();
  return c === p || c.startsWith(p + "\\") || c.startsWith(p + "/");
}

// All *.jsonl transcripts in a project folder, newest first.
function sessionFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const p = path.join(dir, name);
    try {
      out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs });
    } catch {
      /* removed while scanning */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Newest *.jsonl in a project folder (the session being used right now).
function latestSessionFile(dir) {
  return sessionFiles(dir)[0] || null;
}

// Human label for a chat: the first real user message in the transcript.
function sessionLabel(file, maxLen = 40, headBytes = 16384) {
  let text;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(headBytes, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "user" || e.isSidechain || e.isMeta) continue;
    const content = e.message && e.message.content;
    let s = "";
    if (typeof content === "string") s = content;
    else if (Array.isArray(content)) {
      const t = content.find((c) => c.type === "text" && c.text);
      s = t ? t.text : "";
    }
    s = s.replace(/\s+/g, " ").trim();
    // Skip tool results / command wrappers / empty lines.
    if (!s || s.startsWith("<")) continue;
    return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
  }
  return "";
}

// Parse the last assistant `usage` entry from a transcript, reading only the
// file tail so huge sessions stay cheap. Skips sidechain (subagent) entries.
function lastUsage(file, tailBytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // first line of the tail may be cut in half — ignore
    }
    if (e.type !== "assistant" || e.isSidechain) continue;
    const u = e.message && e.message.usage;
    if (!u) continue;
    const tokens =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    if (!tokens) continue;
    return {
      tokens,
      model: (e.message && e.message.model) || "",
      sessionId: e.sessionId || path.basename(file, ".jsonl"),
      cwd: e.cwd || "",
    };
  }
  return null;
}

// Context window size for a model; `override` (>0) wins.
// Transcripts don't record the real window (it varies by plan: 200k/500k/1M),
// so this is a best-effort default — the claudeUsage.contextWindowTokens
// setting is the source of truth when set.
function windowFor(model, override) {
  if (override && override > 0) return override;
  const m = model || "";
  if (/\[1m\]|-1m/i.test(m)) return 1000000;
  // Opus 4.8+ / Sonnet 4.6+ get 500k on paid Claude Code plans.
  if (/opus-4-([89]|\d{2,})|sonnet-4-([6-9]|\d{2,})|opus-5|sonnet-5|fable/i.test(m))
    return 500000;
  return DEFAULT_WINDOW;
}

function toSession(file, opts) {
  const u = lastUsage(file.path);
  if (!u) return null;
  const windowSize = windowFor(u.model, opts.windowOverride);
  return {
    ...u,
    windowSize,
    pct: Math.min(100, Math.round((u.tokens / windowSize) * 100)),
    file: file.path,
    lastActivity: file.mtimeMs,
    label: sessionLabel(file.path),
  };
}

/**
 * Read the live context state for the workspace at `cwd` (newest chat).
 * Returns null when there is no transcript yet.
 * @param {string} cwd  Workspace folder path.
 * @param {{claudeDir?: string, windowOverride?: number}} [opts]
 */
function readContext(cwd, opts = {}) {
  if (!cwd) return null;
  const dir = path.join(projectsRoot(opts.claudeDir), projectDirName(cwd));
  const file = latestSessionFile(dir);
  if (!file) return null;
  return toSession(file, opts);
}

/**
 * All chats for `cwd` active within `activeMs` (default 30 min), newest first.
 * Includes chats started in subfolders of `cwd` (they live in their own
 * project dirs); each candidate is verified against the transcript's `cwd`.
 * Each entry: { sessionId, label, tokens, pct, windowSize, model, lastActivity }.
 */
function activeSessions(cwd, opts = {}) {
  if (!cwd) return [];
  const activeMs = opts.activeMs || 30 * 60 * 1000;
  const now = opts.now || Date.now();
  let files = [];
  for (const dir of projectDirsFor(cwd, opts.claudeDir)) {
    files = files.concat(sessionFiles(dir));
  }
  const out = [];
  for (const f of files.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (now - f.mtimeMs > activeMs) break; // sorted newest-first
    const s = toSession(f, opts);
    if (s && isWithin(s.cwd, cwd)) out.push(s);
  }
  return out;
}

// ---- daily token / cost stats ---------------------------------------------

// Rough API list prices per million tokens: [input, output].
// Cache reads bill at 0.1x input, cache writes at 1.25x input.
const PRICES = [
  { match: /opus/i, in: 15, out: 75 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 1, out: 5 },
];

function priceFor(model) {
  const p = PRICES.find((x) => x.match.test(model || ""));
  return p || { in: 3, out: 15 }; // unknown model — assume sonnet-class
}

function localDayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Sum a transcript's assistant usage since `sinceMs`, per model.
// Streaming can write several lines for one API message, so entries are
// deduped on message.id + requestId (usage is identical across duplicates).
function fileUsageSince(file, sinceMs) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const models = {};
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "assistant" || !e.message || !e.message.usage) continue;
    if (e.timestamp && new Date(e.timestamp).getTime() < sinceMs) continue;
    const key = `${e.message.id || ""}:${e.requestId || ""}`;
    if (key !== ":" && seen.has(key)) continue;
    seen.add(key);
    const u = e.message.usage;
    const model = e.message.model || "unknown";
    const m = (models[model] = models[model] || { in: 0, out: 0, cr: 0, cw: 0 });
    m.in += u.input_tokens || 0;
    m.out += u.output_tokens || 0;
    m.cr += u.cache_read_input_tokens || 0;
    m.cw += u.cache_creation_input_tokens || 0;
  }
  return models;
}

// Per-file result cache so unchanged transcripts aren't re-parsed every poll.
const statsCache = new Map(); // file -> { mtimeMs, sinceMs, models }

/**
 * Token totals + estimated API-price value for today, across ALL projects
 * (i.e. "how much Claude did I use today on this machine").
 * Returns { models: {name: {in,out,cr,cw}}, tokens, cost } or null.
 */
function todayStats(opts = {}) {
  const now = opts.now || Date.now();
  const sinceMs = opts.sinceMs != null ? opts.sinceMs : localDayStart(now);
  const root = projectsRoot(opts.claudeDir);
  let dirs;
  try {
    dirs = fs.readdirSync(root).map((n) => path.join(root, n));
  } catch {
    return null;
  }
  const totals = {};
  let any = false;
  for (const dir of dirs) {
    for (const f of sessionFiles(dir)) {
      if (f.mtimeMs < sinceMs) continue; // untouched today
      any = true;
      let entry = statsCache.get(f.path);
      if (!entry || entry.mtimeMs !== f.mtimeMs || entry.sinceMs !== sinceMs) {
        entry = { mtimeMs: f.mtimeMs, sinceMs, models: fileUsageSince(f.path, sinceMs) };
        statsCache.set(f.path, entry);
      }
      for (const [model, m] of Object.entries(entry.models)) {
        const t = (totals[model] = totals[model] || { in: 0, out: 0, cr: 0, cw: 0 });
        t.in += m.in;
        t.out += m.out;
        t.cr += m.cr;
        t.cw += m.cw;
      }
    }
  }
  if (!any) return null;
  let tokens = 0;
  let cost = 0;
  for (const [model, m] of Object.entries(totals)) {
    tokens += m.in + m.out + m.cr + m.cw;
    const p = priceFor(model);
    cost +=
      (m.in * p.in + m.out * p.out + m.cr * p.in * 0.1 + m.cw * p.in * 1.25) / 1e6;
  }
  return { models: totals, tokens, cost };
}

// 184532 -> "184.5k", 950 -> "950"
function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k";
  return String(n);
}

// Compact "active Xm ago" label for the tooltip.
function agoLabel(mtimeMs, now = Date.now()) {
  const min = Math.round((now - mtimeMs) / 60000);
  if (min < 1) return "active now";
  if (min < 60) return `active ${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `active ${h}h ago`;
  return `active ${Math.round(h / 24)}d ago`;
}

module.exports = {
  DEFAULT_WINDOW,
  projectDirName,
  projectsRoot,
  projectDirsFor,
  isWithin,
  sessionFiles,
  latestSessionFile,
  sessionLabel,
  lastUsage,
  windowFor,
  readContext,
  activeSessions,
  localDayStart,
  fileUsageSince,
  todayStats,
  priceFor,
  fmtTokens,
  agoLabel,
};
