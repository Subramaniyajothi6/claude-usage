const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("../context");

// Build a fake ~/.claude/projects tree with a transcript for `cwd`.
function fixture(lines, cwd = "D:\\my proj") {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-test-"));
  const dir = path.join(claudeDir, "projects", C.projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "abc-123.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { claudeDir, cwd, file };
}

const assistant = (tokens, extra = {}) => ({
  type: "assistant",
  sessionId: "abc-123",
  message: {
    model: "claude-sonnet-4-5",
    usage: {
      input_tokens: tokens.in || 0,
      cache_read_input_tokens: tokens.read || 0,
      cache_creation_input_tokens: tokens.create || 0,
      output_tokens: tokens.out || 0,
    },
  },
  ...extra,
});

test("projectDirName replaces non-alphanumerics with dashes", () => {
  assert.equal(C.projectDirName("D:\\my proj"), "D--my-proj");
  assert.equal(C.projectDirName("/home/u/x.y_z"), "-home-u-x-y-z");
});

test("readContext sums input + cache tokens of the last assistant message", () => {
  const { claudeDir, cwd } = fixture([
    { type: "user", message: { role: "user" } },
    assistant({ in: 5, read: 1000, create: 500 }),
    { type: "user", message: { role: "user" } },
    assistant({ in: 10, read: 80000, create: 4000, out: 999 }),
  ]);
  const c = C.readContext(cwd, { claudeDir });
  assert.equal(c.tokens, 84010); // output_tokens not counted
  assert.equal(c.windowSize, 200000);
  assert.equal(c.pct, 42);
  assert.equal(c.sessionId, "abc-123");
});

test("readContext skips sidechain entries and malformed lines", () => {
  const { claudeDir, cwd, file } = fixture([
    assistant({ in: 100, read: 50000 }),
    assistant({ in: 9, read: 999999 }, { isSidechain: true }),
  ]);
  fs.appendFileSync(file, "{not json\n");
  const c = C.readContext(cwd, { claudeDir });
  assert.equal(c.tokens, 50100);
});

test("readContext returns null when there is no transcript", () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-empty-"));
  assert.equal(C.readContext("D:\\nothing", { claudeDir }), null);
});

test("latestSessionFile picks the newest jsonl", () => {
  const { claudeDir, cwd } = fixture([assistant({ in: 1, read: 10 })]);
  const dir = path.join(claudeDir, "projects", C.projectDirName(cwd));
  const newer = path.join(dir, "zzz.jsonl");
  fs.writeFileSync(newer, JSON.stringify(assistant({ in: 7, read: 70 })) + "\n");
  const future = Date.now() / 1000 + 60;
  fs.utimesSync(newer, future, future);
  assert.equal(C.latestSessionFile(dir).path, newer);
  assert.equal(C.readContext(cwd, { claudeDir }).tokens, 77);
});

test("windowFor: model-family defaults, 1M detection, override wins", () => {
  assert.equal(C.windowFor("claude-sonnet-4-5"), 200000);
  assert.equal(C.windowFor("claude-sonnet-4-5[1m]"), 1000000);
  assert.equal(C.windowFor("claude-opus-4-8"), 500000); // 500k on paid plans
  assert.equal(C.windowFor("claude-sonnet-4-6"), 500000);
  assert.equal(C.windowFor("claude-opus-4-8", 1000000), 1000000); // setting wins
  assert.equal(C.windowFor("anything", 123456), 123456);
});

test("pct is clamped to 100", () => {
  const { claudeDir, cwd } = fixture([assistant({ in: 0, read: 500000 })]);
  assert.equal(C.readContext(cwd, { claudeDir }).pct, 100);
});

test("fmtTokens renders compact token counts", () => {
  assert.equal(C.fmtTokens(950), "950");
  assert.equal(C.fmtTokens(84010), "84.0k");
  assert.equal(C.fmtTokens(184532), "185k");
  assert.equal(C.fmtTokens(null), "—");
});

test("sessionLabel returns the first real user message, trimmed", () => {
  const { file } = fixture([
    { type: "user", isMeta: true, message: { content: "meta stuff" } },
    { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    {
      type: "user",
      message: {
        content: [{ type: "text", text: "  fix the   login bug in auth.js please, it fails on empty passwords " }],
      },
    },
    assistant({ in: 1, read: 10 }),
  ]);
  const label = C.sessionLabel(file);
  assert.equal(label.length, 40);
  assert.ok(label.startsWith("fix the login bug in auth.js"));
  assert.ok(label.endsWith("…"));
});

test("activeSessions lists recent chats newest-first and skips idle ones", () => {
  const { claudeDir, cwd, file } = fixture([
    { type: "user", message: { content: "first chat" } },
    assistant({ in: 10, read: 40000 }),
  ]);
  const dir = path.dirname(file);
  const now = Date.now();

  const second = path.join(dir, "def-456.jsonl");
  fs.writeFileSync(
    second,
    [
      JSON.stringify({ type: "user", message: { content: "second chat" } }),
      JSON.stringify(assistant({ in: 5, read: 100000 }, { sessionId: "def-456" })),
    ].join("\n") + "\n"
  );
  fs.utimesSync(second, now / 1000 + 60, now / 1000 + 60); // most recent

  const idle = path.join(dir, "old-789.jsonl");
  fs.writeFileSync(idle, JSON.stringify(assistant({ in: 1, read: 99 })) + "\n");
  const old = (now - 2 * 3600000) / 1000; // 2h idle → excluded
  fs.utimesSync(idle, old, old);

  const list = C.activeSessions(cwd, { claudeDir, now: now + 61000 });
  assert.equal(list.length, 2);
  assert.equal(list[0].sessionId, "def-456");
  assert.equal(list[0].label, "second chat");
  assert.equal(list[0].pct, 50);
  assert.equal(list[1].label, "first chat");
});

test("activeSessions includes chats started in subfolders of the workspace", () => {
  const cwd = "D:\\my proj";
  const { claudeDir } = fixture(
    [
      { type: "user", message: { content: "root chat" } },
      assistant({ in: 1, read: 100 }, { cwd }),
    ],
    cwd
  );
  // A chat launched from D:\my proj\src gets its own project dir.
  const subDir = path.join(claudeDir, "projects", C.projectDirName("D:\\my proj\\src"));
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, "sub-1.jsonl"),
    [
      JSON.stringify({ type: "user", message: { content: "sub chat" } }),
      JSON.stringify(
        assistant({ in: 2, read: 200 }, { sessionId: "sub-1", cwd: "D:\\my proj\\src" })
      ),
    ].join("\n") + "\n"
  );
  // A *sibling* project whose sanitized name shares the prefix must be excluded.
  const sibDir = path.join(claudeDir, "projects", C.projectDirName("D:\\my proj two"));
  fs.mkdirSync(sibDir, { recursive: true });
  fs.writeFileSync(
    path.join(sibDir, "sib-1.jsonl"),
    JSON.stringify(
      assistant({ in: 3, read: 300 }, { sessionId: "sib-1", cwd: "D:\\my proj two" })
    ) + "\n"
  );

  const ids = C.activeSessions(cwd, { claudeDir }).map((s) => s.sessionId);
  assert.ok(ids.includes("abc-123"), "root chat missing");
  assert.ok(ids.includes("sub-1"), "subfolder chat missing");
  assert.ok(!ids.includes("sib-1"), "sibling project leaked in");
});

test("activeSessions works when VS Code lowercases the drive letter", () => {
  // Transcript dir created from "D:\my proj" (as Claude Code writes it) …
  const { claudeDir } = fixture([
    { type: "user", message: { content: "hello" } },
    assistant({ in: 1, read: 100 }, { cwd: "D:\\my proj" }),
  ]);
  // … but VS Code hands us "d:\my proj".
  const list = C.activeSessions("d:\\my proj", { claudeDir });
  assert.equal(list.length, 1);
  assert.equal(list[0].tokens, 101);
});

test("isWithin matches same dir and children, case-insensitively", () => {
  assert.ok(C.isWithin("D:\\Proj", "d:\\proj"));
  assert.ok(C.isWithin("D:\\proj\\src\\app", "D:\\proj"));
  assert.ok(C.isWithin("/home/u/proj/src", "/home/u/proj"));
  assert.ok(!C.isWithin("D:\\proj two", "D:\\proj"));
  assert.ok(C.isWithin("", "D:\\proj")); // old transcripts without cwd
});

test("fileUsageSince sums per model, dedupes streamed lines, respects since", () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const entry = (id, model, usage, ts) => ({
    type: "assistant",
    requestId: "req-" + id,
    timestamp: iso(ts),
    message: { id: "msg-" + id, model, usage },
  });
  const { file } = fixture([]);
  fs.writeFileSync(
    file,
    [
      // duplicate lines for the same API message → counted once
      entry(1, "claude-opus-4-8", { input_tokens: 10, output_tokens: 100 }, now),
      entry(1, "claude-opus-4-8", { input_tokens: 10, output_tokens: 100 }, now),
      entry(2, "claude-sonnet-4-5", { cache_read_input_tokens: 5000, output_tokens: 7 }, now),
      // yesterday → excluded
      entry(3, "claude-opus-4-8", { input_tokens: 999 }, now - 26 * 3600000),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n"
  );
  const m = C.fileUsageSince(file, now - 3600000);
  assert.deepEqual(m["claude-opus-4-8"], { in: 10, out: 100, cr: 0, cw: 0 });
  assert.deepEqual(m["claude-sonnet-4-5"], { in: 0, out: 7, cr: 5000, cw: 0 });
});

test("todayStats totals across projects and estimates cost", () => {
  const now = Date.now();
  const { claudeDir, file } = fixture([]);
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(now).toISOString(),
      message: {
        id: "m1",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1000000, output_tokens: 1000000 },
      },
    }) + "\n"
  );
  const s = C.todayStats({ claudeDir, now, sinceMs: now - 3600000 });
  assert.equal(s.tokens, 2000000);
  // opus: 1M in @ $15 + 1M out @ $75 = $90
  assert.ok(Math.abs(s.cost - 90) < 0.01, `cost was ${s.cost}`);
});

test("priceFor matches model families and falls back", () => {
  assert.equal(C.priceFor("claude-opus-4-8").out, 75);
  assert.equal(C.priceFor("claude-haiku-4-5").in, 1);
  assert.equal(C.priceFor("mystery-model").in, 3);
});

test("agoLabel buckets minutes / hours / days", () => {
  const now = Date.now();
  assert.equal(C.agoLabel(now - 10 * 1000, now), "active now");
  assert.equal(C.agoLabel(now - 5 * 60000, now), "active 5m ago");
  assert.equal(C.agoLabel(now - 3 * 3600000, now), "active 3h ago");
  assert.equal(C.agoLabel(now - 50 * 3600000, now), "active 2d ago");
});
