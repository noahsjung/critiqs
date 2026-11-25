import type { ViewState } from "@critiqs/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short relative time, like Figma's comment entries: "now", "5m", "3h", "2d", then a date. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

const AVATAR_COLORS = ["#7c3aed", "#0d9488", "#db2777", "#2563eb", "#ea580c", "#4f46e5", "#059669", "#b45309"];

export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

/** Longest value shown in a view state description; longer ones, such as a host's recorded draft, are shortened. */
const MAX_SHOWN_VALUE = 60;

export function describeViewState(viewState: ViewState): string {
  return Object.entries(viewState)
    .filter(([, value]) => value !== null && value !== false && value !== "")
    .map(([key, value]) => (value === true ? key : `${key}: ${shorten(String(value))}`))
    .join(", ");
}

function shorten(value: string): string {
  return value.length > MAX_SHOWN_VALUE ? `${value.slice(0, MAX_SHOWN_VALUE - 1)}…` : value;
}

/** Short browser name from a user agent, for context lines. */
export function describeBrowser(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  const match = /(Edg|Firefox|Chrome|Safari)\/(\d+)/.exec(userAgent);
  if (match === null) return userAgent.slice(0, 60);
  const name = { Edg: "Edge", Firefox: "Firefox", Chrome: "Chrome", Safari: "Safari" }[match[1]!] ?? match[1];
  const version = match[1] === "Safari" ? (/Version\/(\d+)/.exec(userAgent)?.[1] ?? match[2]) : match[2];
  return `${name} ${version}`;
}
