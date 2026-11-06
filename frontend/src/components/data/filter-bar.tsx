"use client";

import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ColumnInfo, FilterOp, FilterSpec } from "@/lib/types";

export const OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: "eq", label: "=", needsValue: true },
  { op: "neq", label: "≠", needsValue: true },
  { op: "gt", label: ">", needsValue: true },
  { op: "gte", label: "≥", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "lte", label: "≤", needsValue: true },
  { op: "contains", label: "contains", needsValue: true },
  { op: "not_contains", label: "does not contain", needsValue: true },
  { op: "starts_with", label: "starts with", needsValue: true },
  { op: "ends_with", label: "ends with", needsValue: true },
  { op: "in", label: "in (a, b, c)", needsValue: true },
  { op: "not_in", label: "not in", needsValue: true },
  { op: "is_null", label: "is NULL", needsValue: false },
  { op: "not_null", label: "is not NULL", needsValue: false },
];

export interface DraftFilter extends FilterSpec {
  id: number;
  enabled: boolean;
}

export function FilterBar({
  columns, filters, mode, onChange, onModeChange, onApply, onClose,
}: {
  columns: ColumnInfo[];
  filters: DraftFilter[];
  mode: "and" | "or";
  onChange: (f: DraftFilter[]) => void;
  onModeChange: (m: "and" | "or") => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const update = (id: number, patch: Partial<DraftFilter>) => onChange(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const add = () => onChange([...filters, { id: Date.now(), column: columns[0]?.name ?? "", op: "eq", value: "", enabled: true }]);

  return (
    <div className="space-y-1.5 border-b bg-surface/60 px-2 py-2" onKeyDown={(e) => e.key === "Enter" && onApply()}>
      {filters.map((f, i) => {
        const op = OPS.find((o) => o.op === f.op)!;
        return (
          <div key={f.id} className="flex items-center gap-1.5">
            <div className="w-12 text-right text-[11px] text-muted-foreground">
              {i === 0 ? "where" : (
                <button className="rounded px-1 font-medium uppercase hover:bg-accent hover:text-foreground" onClick={() => onModeChange(mode === "and" ? "or" : "and")} title="Toggle AND / OR">
                  {mode}
                </button>
              )}
            </div>
            <input type="checkbox" checked={f.enabled} onChange={(e) => update(f.id, { enabled: e.target.checked })} className="accent-primary" aria-label="Enable filter" />
            <Select value={f.column} onValueChange={(v) => update(f.id, { column: v })}>
              <SelectTrigger size="sm" className="h-7 w-44 font-mono text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {columns.map((c) => <SelectItem key={c.name} value={c.name} className="font-mono text-[12px]">{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={f.op} onValueChange={(v) => update(f.id, { op: v as FilterOp })}>
              <SelectTrigger size="sm" className="h-7 w-36 text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {OPS.map((o) => <SelectItem key={o.op} value={o.op} className="text-[12px]">{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {op.needsValue ? (
              <Input className="h-7 max-w-80 flex-1 font-mono text-[12px]" value={String(f.value ?? "")} onChange={(e) => update(f.id, { value: e.target.value })} placeholder="value" autoFocus={i === filters.length - 1} />
            ) : (
              <div className="flex-1" />
            )}
            <Button variant="ghost" size="icon-xs" onClick={() => onChange(filters.filter((x) => x.id !== f.id))} aria-label="Remove filter"><Trash2 /></Button>
          </div>
        );
      })}
      <div className="flex items-center gap-1.5 pl-[54px]">
        <Button variant="ghost" size="xs" onClick={add}><Plus /> Add filter</Button>
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" onClick={onApply}>Apply</Button>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close filters"><X /></Button>
        </div>
      </div>
    </div>
  );
}
