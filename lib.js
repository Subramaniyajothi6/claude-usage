// Pure, dependency-free logic so it can be unit-tested without a running
// VS Code instance. extension.js requires everything from here.

const ESC = "\x1b[";
// Clear scrollback (3J) + screen (2J) + cursor home (H).
const CLEAR = ESC + "3J" + ESC + "2J" + ESC + "H";
const RESET = ESC + "0m";
const BOLD = ESC + "1m";
const GRAY = ESC + "90m";
const BLUE = ESC + "38;2;59;130;246m";
const YELLOW = ESC + "38;2;224;175;59m";
const RED = ESC + "38;2;227;93;106m";
const TRACK = ESC + "38;2;90;90;90m";

function pad(n) {
  return String(n).padStart(2, "0");
}

function clamp(p) {
  return Math.max(0, Math.min(100, p));
}

function relReset(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "Resets now";
  const min = Math.round(ms / 60000);
  if (min < 60) return `Resets in ${min} min`;
  const hrs = Math.floor(min / 60),
    rem = min % 60;
  if (hrs < 24) return `Resets in ${hrs}h ${rem}m`;
  return absReset(iso);
}

function absReset(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `Resets ${day} ${h}:${m} ${ap}`;
}

// Compact time-until-reset for the status bar: 11m / 3h / 3d / 1w.
function shortUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const m = ms / 60000;
  if (m < 60) return Math.max(1, Math.round(m)) + "m";
  const h = m / 60;
  if (h < 24) return Math.round(h) + "h";
  const d = h / 24;
  if (d < 7) return Math.round(d) + "d";
  return Math.round(d / 7) + "w";
}

function barColor(p) {
  return p >= 90 ? RED : p >= 75 ? YELLOW : BLUE;
}

function headerRow(label, pct, cols) {
  const right = `${pct}% used`;
  const space = Math.max(1, cols - label.length - right.length);
  return BOLD + label + RESET + " ".repeat(space) + GRAY + right + RESET;
}

function barRow(pct, cols) {
  const width = Math.max(10, Math.min(cols, 50));
  const filled = Math.round((width * clamp(pct)) / 100);
  return (
    barColor(pct) + "█".repeat(filled) + TRACK + "█".repeat(width - filled) + RESET
  );
}

function block(label, obj, resetFn, cols) {
  if (!obj) return [];
  const p = Math.round(clamp(obj.utilization));
  return [
    headerRow(label, p, cols),
    barRow(p, cols),
    GRAY + resetFn(obj.resets_at) + RESET,
  ];
}

// Redraw in place: home, overwrite each line clearing to EOL, clear below.
function paint(lines) {
  return ESC + "H" + lines.join(ESC + "K\r\n") + ESC + "K" + ESC + "J";
}

function buildFrame(data, cols, updatedAt, note) {
  const w = Math.max(20, cols || 60);
  let lines = [""];
  lines = lines.concat(block("Current session", data.five_hour, relReset, w));
  lines.push("", "", BOLD + "Weekly limits" + RESET, "");
  lines = lines.concat(block("All models", data.seven_day, absReset, w));
  if (data.seven_day_opus)
    lines = lines.concat(["", ...block("Opus", data.seven_day_opus, absReset, w)]);
  if (data.seven_day_sonnet)
    lines = lines.concat(["", ...block("Sonnet", data.seven_day_sonnet, absReset, w)]);
  lines.push("", "", GRAY + `updated ${updatedAt}  ·  press r to refresh` + RESET);
  if (note) lines.push(YELLOW + note + RESET);
  return paint(lines);
}

function errorFrame(message) {
  return paint([
    "",
    RED + "Could not load usage" + RESET,
    "",
    GRAY + String(message) + RESET,
    "",
    GRAY + "Make sure you are signed in to Claude Code." + RESET,
    GRAY + "press r to retry" + RESET,
  ]);
}

// A short text bar for the status-bar tooltip.
function tooltipBar(pct, n = 16) {
  const filled = Math.round((n * clamp(pct)) / 100);
  return "█".repeat(filled) + "░".repeat(n - filled);
}

// The dynamic status-bar text (without the leading icon).
function statusText(data) {
  const fh = Math.round((data.five_hour || {}).utilization || 0);
  const sd = Math.round((data.seven_day || {}).utilization || 0);
  const csT = data.five_hour ? " - " + shortUntil(data.five_hour.resets_at) : "";
  const wsT = data.seven_day ? " - " + shortUntil(data.seven_day.resets_at) : "";
  return {
    fh,
    sd,
    worst: Math.max(fh, sd),
    text: `CS ${fh}%${csT} | WS ${sd}%${wsT}`,
  };
}

// Exponential backoff in ms for the Nth consecutive error, capped at 30 min.
function backoffMs(errorCount) {
  return Math.min(60000 * Math.pow(2, errorCount), 30 * 60 * 1000);
}

// Highest threshold that `pct` has reached beyond `lastFired`, else null.
// e.g. newlyCrossed(92, [80,90], 80) -> 90 ; newlyCrossed(85, [80,90], 80) -> null
function newlyCrossed(pct, thresholds, lastFired) {
  let hit = null;
  for (const t of [...thresholds].sort((a, b) => a - b)) {
    if (pct >= t && t > (lastFired || 0)) hit = t;
  }
  return hit;
}

const SPARK = "▁▂▃▄▅▆▇█";

// Render a list of 0..max values as a unicode sparkline.
function sparkline(values, max = 100) {
  if (!values || !values.length) return "";
  return values
    .map((v) => {
      const c = Math.max(0, Math.min(1, v / max));
      return SPARK[Math.min(SPARK.length - 1, Math.round(c * (SPARK.length - 1)))];
    })
    .join("");
}

module.exports = {
  CLEAR,
  GRAY,
  RESET,
  pad,
  clamp,
  relReset,
  absReset,
  shortUntil,
  barColor,
  headerRow,
  barRow,
  block,
  paint,
  buildFrame,
  errorFrame,
  tooltipBar,
  statusText,
  backoffMs,
  newlyCrossed,
  sparkline,
};
