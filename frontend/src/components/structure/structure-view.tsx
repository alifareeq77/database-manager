"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle, ArrowRight, Columns3, Eraser, KeyRound, Link2, ListTree, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, ShieldCheck,
  Trash2, Type, Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { matchesTable, onObjectsChanged } from "@/lib/events";
import { formatBytes, formatNumber } from "@/lib/format";
import type { Connection, ObjectKind, SchemaOp, TableStructure } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { copyText, dropObject, truncateObject } from "@/components/explorer/object-actions";
import { StructureOpDialog, type OpRequest } from "./structure-op-dialog";

interface Props {
  conn: Connection;
  database: string | null;
  schema: string | null;
  table: string;
  objectKind: ObjectKind;
}

export function StructureView({ conn, database, schema, table, objectKind }: Props) {
  const [data, setData] = useState<TableStructure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [op, setOp] = useState<OpRequest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.explorer.structure(conn.id, database, schema, table));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conn.id, database, schema, table]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / target change
    void load();
  }, [load]);
  useEffect(() => onObjectsChanged((d) => matchesTable(d, conn.id, database, schema, table) && void load()), [conn.id, database, schema, table, load]);

  const isTable = objectKind === "table";
  const canEdit = isTable && !conn.read_only;
  const caps = conn.capabilities;
  const ref = { conn, database, schema, name: table, kind: objectKind };

  /** Hand a single operation to the review dialog. */
  const change = (title: string, operation: SchemaOp, onApplied?: () => void) =>
    useUi.getState().requestSchemaChange({ connectionId: conn.id, database, title, change: { schema_name: schema, table, operations: [operation] }, onApplied });

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertCircle className="size-5 text-destructive" />
        <p className="max-w-lg break-words text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!data) return <StructureSkeleton />;

  const constraints = data.constraints.filter((c) => c.type === "unique" || c.type === "check");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-4 pb-10">
        {/* Summary + table-level actions */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-mono text-[15px] font-semibold">{data.name}</h2>
              <Badge variant="secondary" className="text-[10px]">{data.kind.replace("_", " ")}</Badge>
              {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
              <span>{data.columns.length} columns</span>
              {data.row_estimate !== null && <span>~{formatNumber(data.row_estimate)} rows</span>}
              {data.total_size_bytes !== null && <span>{formatBytes(data.total_size_bytes)} on disk</span>}
              {data.primary_key.length > 0 && <span>PK ({data.primary_key.join(", ")})</span>}
            </div>
            {data.comment && <p className="mt-1.5 text-[12px]">{data.comment}</p>}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw className={cn(loading && "animate-spin")} /> Refresh</Button>
            {canEdit && (
              <>
                <Button variant="outline" size="sm" onClick={() => setOp({ kind: "add_column" })}><Plus /> Column</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label="More table actions"><MoreHorizontal /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onSelect={() => setOp({ kind: "create_index" })}><Zap /> Add index…</DropdownMenuItem>
                    {caps.add_constraint && (
                      <>
                        <DropdownMenuItem onSelect={() => setOp({ kind: "add_foreign_key" })}><Link2 /> Add foreign key…</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setOp({ kind: "add_unique" })}><KeyRound /> Add unique constraint…</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setOp({ kind: "add_check" })}><ShieldCheck /> Add check constraint…</DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setOp({ kind: "rename_table" })}><Pencil /> Rename table…</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => truncateObject(ref)}><Eraser /> Truncate…</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => dropObject(ref)}><Trash2 /> Drop table…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>

        {/* Columns */}
        <Section icon={Columns3} title="Columns" count={data.columns.length}>
          <Table head={["#", "Name", "Type", "Nullable", "Default", "Comment", ""]}>
            {data.columns.map((c) => (
              <tr key={c.name} className="group">
                <td className="w-8 text-muted-foreground tabular-nums">{c.ordinal}</td>
                <td className="font-mono font-medium">
                  <span className="flex items-center gap-1.5">
                    {c.is_primary_key && <KeyRound className="size-3 text-warning" aria-label="Primary key" />}
                    {c.name}
                    {c.is_auto_increment && <Badge variant="outline" className="h-4 px-1 text-[9px]">auto</Badge>}
                  </span>
                </td>
                <td className="font-mono text-syntax-number">{c.data_type}</td>
                <td>{c.nullable ? <span className="text-muted-foreground">yes</span> : <span className="font-medium">NOT NULL</span>}</td>
                <td className="max-w-56 truncate font-mono text-muted-foreground" title={c.default ?? undefined}>{c.default ?? ""}</td>
                <td className="max-w-64 truncate text-muted-foreground" title={c.comment ?? undefined}>{c.comment ?? ""}</td>
                <td className="w-8">
                  {canEdit && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${c.name}`}><MoreHorizontal /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => setOp({ kind: "rename_column", column: c })}><Pencil /> Rename…</DropdownMenuItem>
                        {caps.alter_column && <DropdownMenuItem onSelect={() => setOp({ kind: "alter_column", column: c })}><Type /> Change type / null / default…</DropdownMenuItem>}
                        <DropdownMenuItem onSelect={() => setOp({ kind: "create_index", column: c })}><Zap /> Index this column…</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void copyText(c.name, "Column name copied")}><Columns3 /> Copy name</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" disabled={data.columns.length === 1} onSelect={() => change(`Drop column ${c.name}`, { op: "drop_column", column: c.name })}>
                          <Trash2 /> Drop column…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Section>

        {/* Indexes */}
        {(isTable || data.indexes.length > 0) && (
          <Section icon={Zap} title="Indexes" count={data.indexes.length} action={canEdit ? () => setOp({ kind: "create_index" }) : undefined}>
            {data.indexes.length === 0 ? <Empty>No indexes.</Empty> : (
              <Table head={["Name", "Columns", "Type", "Method", "Size", ""]}>
                {data.indexes.map((ix) => (
                  <tr key={ix.name} className="group">
                    <td className="font-mono font-medium">{ix.name}</td>
                    <td className="font-mono">{ix.columns.join(", ") || <span className="text-muted-foreground" title={ix.definition ?? undefined}>expression</span>}</td>
                    <td>{ix.primary ? <Badge className="text-[10px]">primary</Badge> : ix.unique ? <Badge variant="secondary" className="text-[10px]">unique</Badge> : <span className="text-muted-foreground">index</span>}</td>
                    <td className="text-muted-foreground">{ix.method ?? ""}</td>
                    <td className="text-muted-foreground tabular-nums">{ix.size_bytes !== null ? formatBytes(ix.size_bytes) : ""}</td>
                    <td className="w-8">
                      {canEdit && !ix.primary && (
                        <RowDelete label={`Drop index ${ix.name}`} onClick={() => change(`Drop index ${ix.name}`, { op: "drop_index", name: ix.name })} />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        )}

        {/* Foreign keys */}
        {(isTable || data.foreign_keys.length > 0) && (
          <Section icon={Link2} title="Foreign keys" count={data.foreign_keys.length} action={canEdit && caps.add_constraint ? () => setOp({ kind: "add_foreign_key" }) : undefined}>
            {data.foreign_keys.length === 0 ? <Empty>No foreign keys.</Empty> : (
              <Table head={["Name", "Columns", "References", "On update", "On delete", ""]}>
                {data.foreign_keys.map((fk) => (
                  <tr key={fk.name} className="group">
                    <td className="font-mono font-medium">{fk.name}</td>
                    <td className="font-mono">{fk.columns.join(", ")}</td>
                    <td>
                      <button
                        className="flex items-center gap-1 font-mono text-primary hover:underline"
                        onClick={() => useWorkspace.getState().openTable({ connectionId: conn.id, database, schema: fk.ref_schema ?? schema, table: fk.ref_table, objectKind: "table", view: "structure" })}
                      >
                        {fk.ref_schema && fk.ref_schema !== schema ? `${fk.ref_schema}.` : ""}{fk.ref_table}({fk.ref_columns.join(", ")})
                      </button>
                    </td>
                    <td className="text-muted-foreground">{fk.on_update ?? ""}</td>
                    <td className="text-muted-foreground">{fk.on_delete ?? ""}</td>
                    <td className="w-8">
                      {canEdit && caps.add_constraint && (
                        <RowDelete label={`Drop foreign key ${fk.name}`} onClick={() => change(`Drop foreign key ${fk.name}`, { op: "drop_constraint", name: fk.name, constraint_type: "foreign_key" })} />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        )}

        {/* Unique / check constraints */}
        {(constraints.length > 0 || (canEdit && caps.add_constraint)) && (
          <Section icon={ShieldCheck} title="Constraints" count={constraints.length} action={canEdit && caps.add_constraint ? () => setOp({ kind: "add_check" }) : undefined}>
            {constraints.length === 0 ? <Empty>No unique or check constraints.</Empty> : (
              <Table head={["Name", "Type", "Definition", ""]}>
                {constraints.map((c) => (
                  <tr key={c.name} className="group">
                    <td className="font-mono font-medium">{c.name}</td>
                    <td><Badge variant="secondary" className="text-[10px]">{c.type}</Badge></td>
                    <td className="font-mono text-muted-foreground">{c.definition ?? c.columns.join(", ")}</td>
                    <td className="w-8">
                      {canEdit && caps.add_constraint && (
                        <RowDelete label={`Drop constraint ${c.name}`} onClick={() => change(`Drop constraint ${c.name}`, { op: "drop_constraint", name: c.name, constraint_type: c.type as "unique" | "check" })} />
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        )}

        {/* Referenced by */}
        {data.referenced_by.length > 0 && (
          <Section icon={ArrowRight} title="Referenced by" count={data.referenced_by.length}>
            <Table head={["Table", "Columns", "Constraint", "On delete"]}>
              {data.referenced_by.map((fk) => (
                <tr key={`${fk.ref_schema}.${fk.ref_table}.${fk.name}`}>
                  <td>
                    <button
                      className="font-mono text-primary hover:underline"
                      onClick={() => useWorkspace.getState().openTable({ connectionId: conn.id, database, schema: fk.ref_schema ?? schema, table: fk.ref_table, objectKind: "table", view: "structure" })}
                    >
                      {fk.ref_schema && fk.ref_schema !== schema ? `${fk.ref_schema}.` : ""}{fk.ref_table}
                    </button>
                  </td>
                  <td className="font-mono">{fk.columns.join(", ")} → {fk.ref_columns.join(", ")}</td>
                  <td className="font-mono text-muted-foreground">{fk.name}</td>
                  <td className="text-muted-foreground">{fk.on_delete ?? ""}</td>
                </tr>
              ))}
            </Table>
          </Section>
        )}

        {/* Triggers */}
        {data.triggers.length > 0 && (
          <Section icon={ListTree} title="Triggers" count={data.triggers.length}>
            <Table head={["Name", "Timing", "Event", "Definition"]}>
              {data.triggers.map((t) => (
                <tr key={t.name}>
                  <td className="font-mono font-medium">{t.name}</td>
                  <td>{t.timing ?? ""}</td>
                  <td>{t.event ?? ""}</td>
                  <td className="max-w-xl truncate font-mono text-muted-foreground" title={t.definition ?? undefined}>{t.definition ?? ""}</td>
                </tr>
              ))}
            </Table>
          </Section>
        )}

        {/* View definition */}
        {data.view_definition && (
          <Section icon={ListTree} title="Definition">
            <pre className="overflow-x-auto rounded-md border bg-surface p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap">{data.view_definition.trim()}</pre>
          </Section>
        )}
      </div>

      {op && (
        <StructureOpDialog
          request={op}
          conn={conn}
          database={database}
          schema={schema}
          table={table}
          structure={data}
          onClose={() => setOp(null)}
        />
      )}
    </div>
  );
}

function Section({ icon: Icon, title, count, action, children }: { icon: React.ElementType; title: string; count?: number; action?: () => void; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {count !== undefined && <span className="text-[11px] text-muted-foreground tabular-nums">{count}</span>}
        {action && (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={action}><Plus /> Add</Button>
        )}
      </div>
      {children}
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-[12px]">
        <thead className="bg-surface text-[11px] text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium">{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody className="[&>tr]:border-t [&>tr>td]:px-3 [&>tr>td]:py-1.5 [&>tr:hover]:bg-accent/40">{children}</tbody>
      </table>
    </div>
  );
}

function RowDelete({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100" onClick={onClick} aria-label={label} title={label}>
      <Trash2 />
    </Button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed px-3 py-3 text-[12px] text-muted-foreground">{children}</p>;
}

function StructureSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-4 w-80" />
      {[0, 1].map((s) => (
        <div key={s} className="space-y-1">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: s ? 3 : 7 }).map((_, i) => <Skeleton key={i} className="h-7 opacity-60" />)}
        </div>
      ))}
    </div>
  );
}
