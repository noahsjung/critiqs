import type { ProjectUsage } from "@critiqs/core";
import { NEAR_LIMIT } from "./ds.tsx";

export type UsageRow = ProjectUsage["rows"][number];

export const USAGE_NAMES: Record<UsageRow["metric"], string> = {
  projects: "Projects",
  threads: "Threads",
  messages: "Comments",
  reviewers: "Reviewers",
  captureBytes: "Images stored",
  mentionEmails: "Mention emails",
  aiRequests: "Critiqs AI credits",
  aiCredits: "Critiqs AI credits",
};

const PERIOD_NAMES: Record<UsageRow["period"], string> = { total: "", month: " this month", day: " today" };

export const usageName = ({ metric, period }: Pick<UsageRow, "metric" | "period">) => `${USAGE_NAMES[metric]}${PERIOD_NAMES[period]}`;

export function amount(metric: string, value: number): string {
  if (metric !== "captureBytes") return value.toLocaleString("en-US");
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
}

export function ceilingOf(row: UsageRow): number {
  if (row.overage === undefined) return row.max;
  return row.overage.cap === null ? Number.POSITIVE_INFINITY : row.max + row.overage.cap;
}

export function usageText(row: UsageRow, cost: (extra: number) => string = () => ""): { text: string; tone: "note" | "caution" | "error" } {
  const used = `${amount(row.metric, row.used)} of ${amount(row.metric, row.max)}`;
  if (row.overage === undefined) return row.used >= row.max ? { text: `${used}, limit reached`, tone: "error" } : { text: used, tone: "note" };
  const { cap } = row.overage;
  const extra = row.used - row.max;
  if (extra < 0) return { text: used, tone: "note" };
  const spent = extra === 0 ? used : `${used} · ${amount(row.metric, extra)} extra${cost(extra)}`;
  if (cap !== null && extra >= cap) return { text: `${spent}, cap reached`, tone: "error" };
  if (extra === 0) return { text: `${used} · included credits used, extra allowed`, tone: "note" };
  if (cap === null) return { text: `${spent}, no cap`, tone: "note" };
  const left = `${spent}, ${amount(row.metric, cap - extra)} left`;
  return extra >= cap * NEAR_LIMIT ? { text: `${left}, near cap`, tone: "caution" } : { text: left, tone: "note" };
}
