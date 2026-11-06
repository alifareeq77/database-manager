import { cellToText, formatBytes, formatDateValue, isBinary } from "@/lib/format";
import type { CellValue, TypeCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

export function isNumeric(category: TypeCategory) {
  return category === "integer" || category === "float" || category === "decimal";
}

/** Read-only rendering of a single value with type-aware styling. */
export function CellValueView({ value, category }: { value: CellValue; category: TypeCategory }) {
  if (value === null || value === undefined) {
    return <span className="text-[11px] tracking-wide text-null italic">NULL</span>;
  }
  if (isBinary(value)) return <span className="text-muted-foreground">‹binary {formatBytes(value.length)}›</span>;
  if (typeof value === "boolean" || (category === "boolean" && (value === 0 || value === 1))) {
    const b = value === true || value === 1;
    return <span className="text-syntax-bool">{b ? "true" : "false"}</span>;
  }
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return <span className="text-syntax-string">{s.length > 300 ? s.slice(0, 300) + "…" : s}</span>;
  }
  if (typeof value === "number" || isNumeric(category)) return <span className="text-syntax-number tabular-nums">{String(value)}</span>;
  if (category === "datetime" && typeof value === "string") return <span>{formatDateValue(value, category)}</span>;
  if (category === "json" && typeof value === "string") return <span className="text-syntax-string">{value.length > 300 ? value.slice(0, 300) + "…" : value}</span>;
  const s = String(value);
  if (s === "") return <span className="text-null italic">empty</span>;
  return <span className={cn(category === "uuid" && "text-muted-foreground")}>{s.length > 300 ? s.slice(0, 300) + "…" : s.replace(/\n/g, "↵")}</span>;
}

export function prettyValue(value: CellValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object" && !isBinary(value)) return JSON.stringify(value, null, 2);
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        /* not JSON */
      }
    }
  }
  return cellToText(value);
}
