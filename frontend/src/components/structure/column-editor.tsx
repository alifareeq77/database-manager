"use client";

import { useId } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ColumnDef, Engine } from "@/lib/types";
import { COLUMN_TYPES } from "./column-types";

/** Datalist of type suggestions; reference it with `list={id}` on an input. */
export function TypeSuggestions({ id, engine }: { id: string; engine: Engine }) {
  return (
    <datalist id={id}>
      {COLUMN_TYPES[engine].map((t) => <option key={t} value={t} />)}
    </datalist>
  );
}

/** Editable list of column definitions (used by Create table). */
export function ColumnListEditor({ engine, columns, onChange }: { engine: Engine; columns: ColumnDef[]; onChange: (c: ColumnDef[]) => void }) {
  const listId = useId();
  const set = (i: number, patch: Partial<ColumnDef>) => onChange(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: number) => {
    const next = [...columns];
    const [c] = next.splice(i, 1);
    next.splice(i + d, 0, c);
    onChange(next);
  };
  return (
    <div className="overflow-x-auto rounded-md border">
      <TypeSuggestions id={listId} engine={engine} />
      <table className="w-full min-w-[640px] text-[12px]">
        <thead className="bg-surface text-[11px] text-muted-foreground">
          <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium">
            <th>Name</th>
            <th>Type</th>
            <th>Default</th>
            <th className="text-center!" title="Allow NULL">Null</th>
            <th className="text-center!" title="Primary key">PK</th>
            <th className="text-center!" title="Auto increment">Auto</th>
            <th className="text-center!" title="Unique">Uniq</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => (
            <tr key={i} className="border-t [&>td]:px-1.5 [&>td]:py-1">
              <td><Input value={c.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="column_name" className="h-7 font-mono text-[12px]" aria-label="Column name" /></td>
              <td><Input value={c.type} list={listId} onChange={(e) => set(i, { type: e.target.value })} className="h-7 w-40 font-mono text-[12px]" aria-label="Column type" /></td>
              <td><Input value={c.default ?? ""} onChange={(e) => set(i, { default: e.target.value })} placeholder="none" className="h-7 w-32 font-mono text-[12px]" aria-label="Default expression" /></td>
              <td className="text-center"><Checkbox checked={c.nullable && !c.primary_key} disabled={c.primary_key} onCheckedChange={(v) => set(i, { nullable: v === true })} aria-label="Nullable" /></td>
              <td className="text-center"><Checkbox checked={!!c.primary_key} onCheckedChange={(v) => set(i, { primary_key: v === true, nullable: v === true ? false : c.nullable })} aria-label="Primary key" /></td>
              <td className="text-center"><Checkbox checked={!!c.auto_increment} onCheckedChange={(v) => set(i, { auto_increment: v === true })} aria-label="Auto increment" /></td>
              <td className="text-center"><Checkbox checked={!!c.unique} disabled={c.primary_key} onCheckedChange={(v) => set(i, { unique: v === true })} aria-label="Unique" /></td>
              <td>
                <div className="flex justify-end">
                  <Button type="button" variant="ghost" size="icon-xs" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp /></Button>
                  <Button type="button" variant="ghost" size="icon-xs" disabled={i === columns.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown /></Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon-xs" disabled={columns.length === 1} onClick={() => onChange(columns.filter((_, j) => j !== i))} aria-label="Remove column"><Trash2 /></Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove column</TooltipContent>
                  </Tooltip>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
