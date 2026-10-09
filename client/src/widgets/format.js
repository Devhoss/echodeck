/**
 * format.js  —  client/src/widgets/format.js
 *
 * Formatting for widget metrics. Pure and dependency-free so it can be
 * unit-tested without a DOM, and shared by the phone tile and the desktop tile
 * so the two never disagree about what "2.1 MB/s" means.
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * Numeric formatters must never turn a missing value into a believable zero:
 * Number(null) is 0, so an unreported metric would render "0 B" and look like
 * an idle disk rather than an absent one.
 */
function number(value) {
  if (value === null || value === undefined) return Number.NaN;
  return Number(value);
}

/** Compact bytes: "0.9 GB", "2.4 GB", "512 MB". */
export function formatBytes(bytes) {
  const n = number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= GB) return `${round(n / GB, 1)} GB`;
  if (n >= MB) return `${round(n / MB, 0)} MB`;
  if (n >= KB) return `${round(n / KB, 0)} KB`;
  return `${Math.round(n)} B`;
}

/** A rate: "2.1 MB/s". */
export function formatRate(bytesPerSecond) {
  const n = number(bytesPerSecond);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= GB) return `${round(n / GB, 2)} GB/s`;
  if (n >= MB) return `${round(n / MB, 1)} MB/s`;
  if (n >= KB) return `${round(n / KB, 0)} KB/s`;
  return `${Math.round(n)} B/s`;
}

/** A percentage: "18%", with anything unusable shown as an em dash. */
export function formatPercent(value) {
  const n = number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  return `${Math.round(Math.min(100, n))}%`;
}

/** Seconds as a compact duration: "3h 17m", "12m", "4d 3h". */
export function formatUptime(seconds) {
  const n = number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const days = Math.floor(n / 86400);
  const hours = Math.floor((n % 86400) / 3600);
  const minutes = Math.floor((n % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** Celsius: "52°". */
export function formatTemperature(celsius) {
  const n = number(celsius);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}°`;
}

/** The "Last seen" line for a source that went away. */
export function formatLastSeen(timestamp, now = Date.now()) {
  const then = Number(timestamp);
  if (!Number.isFinite(then) || then <= 0) return "never";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** A wall-clock time, for "Last seen: 12:41 AM". */
export function formatClock(timestamp) {
  const then = Number(timestamp);
  if (!Number.isFinite(then) || then <= 0) return "—";
  try {
    return new Date(then).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** A word for each source status, for the status chip and the editor. */
export function statusLabel(status) {
  switch (status) {
    case "online":
      return "ONLINE";
    case "connecting":
      return "CONNECTING";
    case "auth_error":
      return "AUTH ERROR";
    case "unreachable":
      return "TIMED OUT";
    case "unavailable":
      return "NO SOURCE";
    case "offline":
    default:
      return "OFFLINE";
  }
}

export function isProblemStatus(status) {
  return status !== "online" && status !== "connecting";
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
