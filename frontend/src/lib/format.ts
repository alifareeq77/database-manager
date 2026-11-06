import type { CellValue, TypeCategory } from "./types";

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat().format(n);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function relativeTime(iso: string): string {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return d.toLocaleDateString();
}

export function utcDate(iso: string): Date {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
}

export function isBinary(v: unknown): v is { $binary: string; length: number } {
  return typeof v === "object" && v !== null && "$binary" in v;
}

/** Plain-text representation used for copying and for the inline editor. */
export function cellToText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (isBinary(v)) return `<binary ${formatBytes(v.length)}>`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function formatDateValue(v: string, category: TypeCategory): string {
  if (category === "datetime") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime()) && /T/.test(v)) {
      // Show the stored wall-clock value; keep offset if the DB returned one.
      return v.replace("T", " ").replace(/\.\d+/, (m) => (m.length > 4 ? m.slice(0, 4) : m));
    }
  }
  return v;
}

export function csvEscape(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
