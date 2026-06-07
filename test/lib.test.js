const test = require("node:test");
const assert = require("node:assert");
const L = require("../lib");

const inMs = (ms) => new Date(Date.now() + ms).toISOString();
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("clamp keeps values in 0..100", () => {
  assert.equal(L.clamp(-5), 0);
  assert.equal(L.clamp(150), 100);
  assert.equal(L.clamp(42), 42);
});

test("shortUntil formats minutes / hours / days / weeks", () => {
  assert.equal(L.shortUntil(inMs(11 * MIN)), "11m");
  assert.equal(L.shortUntil(inMs(3 * HOUR)), "3h");
  assert.equal(L.shortUntil(inMs(3 * DAY)), "3d");
  assert.equal(L.shortUntil(inMs(8 * DAY)), "1w");
  assert.equal(L.shortUntil(inMs(-1000)), "now");
});

test("relReset is human-friendly and clamps past times", () => {
  assert.equal(L.relReset(inMs(-1000)), "Resets now");
  assert.equal(L.relReset(inMs(11 * MIN)), "Resets in 11 min");
  assert.match(L.relReset(inMs(2 * HOUR + 5 * MIN)), /^Resets in 2h \d+m$/);
});

test("absReset renders a weekday + 12h clock time", () => {
  // 2026-06-11T21:00 local-ish — just assert the shape.
  assert.match(L.absReset("2026-06-11T21:00:00"), /^Resets [A-Za-z]{3} \d{1,2}:\d{2} (AM|PM)$/);
});

test("statusText builds the CS / WS string and worst value", () => {
  const data = {
    five_hour: { utilization: 17, resets_at: inMs(3 * HOUR) },
    seven_day: { utilization: 7, resets_at: inMs(3 * DAY) },
  };
  const s = L.statusText(data);
  assert.equal(s.fh, 17);
  assert.equal(s.sd, 7);
  assert.equal(s.worst, 17);
  assert.equal(s.text, "CS 17% - 3h | WS 7% - 3d");
});

test("statusText tolerates missing sections", () => {
  const s = L.statusText({});
  assert.equal(s.text, "CS 0% | WS 0%");
  assert.equal(s.worst, 0);
});

test("backoffMs grows exponentially and caps at 30 min", () => {
  assert.equal(L.backoffMs(1), 120000);
  assert.equal(L.backoffMs(2), 240000);
  assert.equal(L.backoffMs(20), 30 * 60 * 1000);
});

test("tooltipBar fills proportionally", () => {
  assert.equal(L.tooltipBar(0, 10), "░".repeat(10));
  assert.equal(L.tooltipBar(100, 10), "█".repeat(10));
  assert.equal(L.tooltipBar(50, 10), "█".repeat(5) + "░".repeat(5));
});

test("barRow contains both filled and track blocks and respects width", () => {
  const row = L.barRow(20, 50);
  // 20% of 50 = 10 filled blocks.
  const blocks = (row.match(/█/g) || []).length;
  assert.equal(blocks, 50); // filled + track both use the full-block glyph
  assert.ok(row.includes("\x1b[38;2;59;130;246m")); // blue (below 75)
});

test("barRow turns red at >=90%", () => {
  assert.ok(L.barRow(95, 50).includes("\x1b[38;2;227;93;106m"));
});

test("buildFrame includes section labels and starts with a home/redraw", () => {
  const data = {
    five_hour: { utilization: 17, resets_at: inMs(3 * HOUR) },
    seven_day: { utilization: 7, resets_at: inMs(3 * DAY) },
  };
  const frame = L.buildFrame(data, 60, "4:24 PM", "");
  assert.ok(frame.startsWith("\x1b[H"));
  assert.match(frame, /Current session/);
  assert.match(frame, /Weekly limits/);
  assert.match(frame, /All models/);
});

test("errorFrame surfaces the message", () => {
  const f = L.errorFrame("429 Rate limited");
  assert.match(f, /Could not load usage/);
  assert.match(f, /429 Rate limited/);
});

test("newlyCrossed returns the highest newly-passed threshold", () => {
  assert.equal(L.newlyCrossed(92, [80, 90], 0), 90);
  assert.equal(L.newlyCrossed(85, [80, 90], 0), 80);
  assert.equal(L.newlyCrossed(85, [80, 90], 80), null); // 80 already fired
  assert.equal(L.newlyCrossed(95, [80, 90], 80), 90); // escalates to 90
  assert.equal(L.newlyCrossed(50, [80, 90], 0), null); // below all
});

test("sparkline maps values onto block ramp", () => {
  assert.equal(L.sparkline([]), "");
  assert.equal(L.sparkline([0, 100], 100), "▁█");
  assert.equal(L.sparkline([0, 50, 100], 100).length, 3);
});
