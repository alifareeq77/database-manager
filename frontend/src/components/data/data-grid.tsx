"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type ColumnOrderState, type ColumnSizingState, type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Copy, EyeOff, Filter, FilterX, Key, Maximize2, Trash2, Undo2 } from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cellToText } from "@/lib/format";
import { rowsToCsv, rowsToJson } from "@/lib/sql";
import type { CellValue, FilterOp, SortSpec, TypeCategory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { copyText } from "@/components/explorer/object-actions";
import { safeStorage } from "@/stores/storage";
import { CellValueView, isNumeric, prettyValue } from "./cell-value";

export interface GridColumn {
  name: string;
  category: TypeCategory;
  dataType?: string | null;
  isPk?: boolean;
  nullable?: boolean;
}

export interface DataGridProps {
  columns: GridColumn[];
  rows: CellValue[][];
  rowNumberOffset?: number;
  editable?: boolean;
  edits?: Record<number, Record<string, CellValue>>;
  deleted?: Set<number>;
  onEdit?: (row: number, column: string, value: CellValue | undefined) => void;
  selected?: Set<number>;
  onSelectedChange?: (s: Set<number>) => void;
  sort?: SortSpec[];
  onSortChange?: (s: SortSpec[]) => void; // provided => server-side sorting
  onFilterValue?: (column: string, op: FilterOp, value: CellValue) => void;
  onDeleteRows?: (rows: number[]) => void;
  onRevertRows?: (rows: number[]) => void;
  insertSql?: (rows: number[]) => string;
  hidden?: string[];
  onHide?: (column: string) => void;
  storageKey?: string;
  empty?: React.ReactNode;
}

const ROW_H = 26;
const NUM_W = 52;

function loadLayout(key?: string): { sizing: ColumnSizingState; order: ColumnOrderState } {
  if (!key) return { sizing: {}, order: [] };
  try {
    const raw = safeStorage.getItem(`strata.grid.${key}`) as string | null;
    return raw ? JSON.parse(raw) : { sizing: {}, order: [] };
  } catch {
    return { sizing: {}, order: [] };
  }
}

function defaultWidth(c: GridColumn): number {
  if (c.category === "boolean") return 90;
  if (isNumeric(c.category)) return 110;
  if (c.category === "datetime") return 190;
  if (c.category === "uuid") return 290;
  if (c.category === "json" || c.category === "text") return 220;
  return 160;
}

export function DataGrid(props: DataGridProps) {
  const {
    columns, rows, rowNumberOffset = 0, editable, edits = {}, deleted, onEdit, selected, onSelectedChange, sort, onSortChange,
    onFilterValue, onDeleteRows, onRevertRows, insertSql, hidden = [], onHide, storageKey, empty,
  } = props;
  const serverSort = !!onSortChange;
  const initial = useMemo(() => loadLayout(storageKey), [storageKey]);
  const [sizing, setSizing] = useState<ColumnSizingState>(initial.sizing);
  const [order, setOrder] = useState<ColumnOrderState>(initial.order);
  const [clientSort, setClientSort] = useState<SortingState>([]);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [viewer, setViewer] = useState<{ column: string; value: CellValue } | null>(null);
  const anchor = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragCol = useRef<string | null>(null);

  useEffect(() => {
    if (storageKey) safeStorage.setItem(`strata.grid.${storageKey}`, JSON.stringify({ sizing, order }));
  }, [sizing, order, storageKey]);

  const colDefs = useMemo<ColumnDef<CellValue[]>[]>(
    () =>
      columns.map((c, i) => ({
        id: `${i}:${c.name}`,
        accessorFn: (row) => row[i],
        header: c.name,
        size: defaultWidth(c),
        minSize: 60,
        maxSize: 1200,
        sortingFn: (a, b) => compareValues(a.original[i], b.original[i]),
        meta: c,
      })),
    [columns],
  );

  const columnVisibility = useMemo(
    () => Object.fromEntries(columns.map((c, i) => [`${i}:${c.name}`, !hidden.includes(c.name)])),
    [columns, hidden],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns non-memoizable functions by design
  const table = useReactTable({
    data: rows,
    columns: colDefs,
    state: { columnSizing: sizing, columnOrder: order, sorting: serverSort ? [] : clientSort, columnVisibility },
    onColumnSizingChange: setSizing,
    onColumnOrderChange: setOrder,
    onSortingChange: setClientSort,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: serverSort ? undefined : getSortedRowModel(),
    manualSorting: serverSort,
    enableMultiSort: true,
    isMultiSortEvent: (e) => (e as MouseEvent).shiftKey,
  });

  const modelRows = table.getRowModel().rows;
  const visibleCols = table.getVisibleLeafColumns();
  const totalWidth = NUM_W + visibleCols.reduce((s, c) => s + c.getSize(), 0);

  const virtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
  });

  const colIndex = useCallback((visibleIdx: number) => Number(visibleCols[visibleIdx]?.id.split(":")[0]), [visibleCols]);
  const valueAt = useCallback(
    (dataRow: number, ci: number): CellValue => {
      const name = columns[ci]?.name;
      const e = edits[dataRow];
      return e && name in e ? e[name] : rows[dataRow]?.[ci];
    },
    [columns, edits, rows],
  );

  function sortState(colName: string) {
    if (serverSort) {
      const i = (sort ?? []).findIndex((s) => s.column === colName);
      return i < 0 ? null : { dir: sort![i].direction, n: i + 1, multi: (sort ?? []).length > 1 };
    }
    return null;
  }

  function toggleSort(colName: string, colId: string, shift: boolean, dir?: "asc" | "desc") {
    if (serverSort) {
      const cur = sort ?? [];
      const existing = cur.find((s) => s.column === colName);
      const next = dir ?? (!existing ? "asc" : existing.direction === "asc" ? "desc" : null);
      let out = shift ? cur.filter((s) => s.column !== colName) : [];
      if (next) out = shift ? [...out, { column: colName, direction: next }] : [{ column: colName, direction: next }];
      onSortChange!(out);
    } else {
      const col = table.getColumn(colId);
      if (dir) col?.toggleSorting(dir === "desc", shift);
      else col?.toggleSorting(undefined, shift);
    }
  }

  const selectRow = useCallback(
    (dataRow: number, viewIdx: number, e: React.MouseEvent) => {
      if (!onSelectedChange) return;
      const next = new Set(e.metaKey || e.ctrlKey || e.shiftKey ? selected : []);
      if (e.shiftKey && anchor.current !== null) {
        const [a, b] = [Math.min(anchor.current, viewIdx), Math.max(anchor.current, viewIdx)];
        for (let i = a; i <= b; i++) next.add(modelRows[i].index);
      } else if ((e.metaKey || e.ctrlKey) && next.has(dataRow)) next.delete(dataRow);
      else next.add(dataRow);
      if (!e.shiftKey) anchor.current = viewIdx;
      onSelectedChange(next);
    },
    [onSelectedChange, selected, modelRows],
  );

  const selectedRows = useCallback((fallback?: number) => {
    const s = selected && selected.size ? [...selected] : fallback !== undefined ? [fallback] : [];
    return s.sort((a, b) => a - b);
  }, [selected]);

  const copyRows = useCallback((idxs: number[], format: "tsv" | "csv" | "json" | "sql") => {
    const visible = visibleCols.map((c) => Number(c.id.split(":")[0]));
    const names = visible.map((i) => columns[i].name);
    const data = idxs.map((r) => visible.map((ci) => valueAt(r, ci)));
    if (format === "json") return copyText(rowsToJson(names, data), `Copied ${idxs.length} row(s) as JSON`);
    if (format === "csv") return copyText(rowsToCsv(names, data), `Copied ${idxs.length} row(s) as CSV`);
    if (format === "sql" && insertSql) return copyText(insertSql(idxs), `Copied ${idxs.length} INSERT statement(s)`);
    return copyText(data.map((r) => r.map(cellToText).join("\t")).join("\n"), `Copied ${idxs.length} row(s)`);
  }, [visibleCols, columns, valueAt, insertSql]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing) return;
    const maxR = modelRows.length - 1;
    const maxC = visibleCols.length - 1;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && onSelectedChange) {
      e.preventDefault();
      onSelectedChange(new Set(modelRows.map((r) => r.index)));
      return;
    }
    if (!active) {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key) && maxR >= 0) {
        e.preventDefault();
        setActive({ r: 0, c: 0 });
      }
      return;
    }
    const move = (r: number, c: number) => {
      const nr = Math.max(0, Math.min(maxR, r));
      const nc = Math.max(0, Math.min(maxC, c));
      setActive({ r: nr, c: nc });
      virtualizer.scrollToIndex(nr, { align: "auto" });
    };
    const dataRow = modelRows[active.r]?.index;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(active.r + 1, active.c); break;
      case "ArrowUp": e.preventDefault(); move(active.r - 1, active.c); break;
      case "ArrowLeft": e.preventDefault(); move(active.r, active.c - 1); break;
      case "ArrowRight": case "Tab": e.preventDefault(); move(active.r, active.c + (e.shiftKey && e.key === "Tab" ? -1 : 1)); break;
      case "PageDown": e.preventDefault(); move(active.r + 20, active.c); break;
      case "PageUp": e.preventDefault(); move(active.r - 20, active.c); break;
      case "Home": e.preventDefault(); move(e.ctrlKey ? 0 : active.r, 0); break;
      case "End": e.preventDefault(); move(e.ctrlKey ? maxR : active.r, maxC); break;
      case "Enter": case "F2":
        e.preventDefault();
        if (editable && dataRow !== undefined && !deleted?.has(dataRow)) setEditing(active);
        else if (dataRow !== undefined) setViewer({ column: columns[colIndex(active.c)].name, value: valueAt(dataRow, colIndex(active.c)) });
        break;
      case "Escape": setActive(null); onSelectedChange?.(new Set()); break;
      case "c":
        if ((e.ctrlKey || e.metaKey) && dataRow !== undefined) {
          e.preventDefault();
          if (selected && selected.size > 1) void copyRows(selectedRows(), "tsv");
          else void copyText(cellToText(valueAt(dataRow, colIndex(active.c))), "Copied cell");
        }
        break;
    }
  }

  if (!columns.length) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">{empty ?? "No columns"}</div>;
  }

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full min-h-0 overflow-auto font-mono text-[12px] outline-none"
      role="grid"
      aria-rowcount={modelRows.length}
    >
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        {/* Header */}
        <div className="sticky top-0 z-20 flex h-[30px] border-b bg-surface font-sans" role="row">
          <div className="sticky left-0 z-10 flex shrink-0 items-center justify-center border-r bg-surface text-[10px] text-muted-foreground" style={{ width: NUM_W }}>
            {selected && selected.size > 0 ? selected.size : "#"}
          </div>
          {table.getHeaderGroups()[0].headers.map((h) => {
            const meta = h.column.columnDef.meta as GridColumn;
            const ss = serverSort ? sortState(meta.name) : null;
            const cs = !serverSort ? h.column.getIsSorted() : false;
            const dir = ss?.dir ?? (cs || null);
            return (
              <ContextMenu key={h.id}>
                <ContextMenuTrigger asChild>
                  <div
                    role="columnheader"
                    draggable
                    onDragStart={() => (dragCol.current = h.column.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      const from = dragCol.current;
                      if (!from || from === h.column.id) return;
                      const ids = table.getAllLeafColumns().map((c) => c.id);
                      const cur = order.length ? order.filter((id) => ids.includes(id)) : ids;
                      const rest = ids.filter((id) => !cur.includes(id));
                      const list = [...cur, ...rest].filter((id) => id !== from);
                      list.splice(list.indexOf(h.column.id), 0, from);
                      setOrder(list);
                    }}
                    onClick={(e) => toggleSort(meta.name, h.column.id, e.shiftKey)}
                    className="group relative flex shrink-0 cursor-pointer items-center gap-1 border-r px-2 select-none hover:bg-accent/50"
                    style={{ width: h.getSize() }}
                    title={`${meta.name}${meta.dataType ? ` · ${meta.dataType}` : ""}${meta.nullable === false ? " · NOT NULL" : ""}`}
                  >
                    {meta.isPk && <Key className="size-3 shrink-0 text-warning" />}
                    <span className="truncate text-[12px] font-medium">{meta.name}</span>
                    {meta.dataType && <span className="truncate font-mono text-[10px] text-muted-foreground/70">{meta.dataType}</span>}
                    {dir && (
                      <span className="ml-auto flex shrink-0 items-center text-primary">
                        {dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                        {ss?.multi && <span className="text-[9px]">{ss.n}</span>}
                      </span>
                    )}
                    <div
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        h.getResizeHandler()(e);
                      }}
                      onTouchStart={h.getResizeHandler()}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={() => h.column.resetSize()}
                      className={cn("absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize", h.column.getIsResizing() ? "bg-primary/60" : "hover:bg-primary/40")}
                    />
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48 font-sans">
                  <ContextMenuItem onSelect={() => toggleSort(meta.name, h.column.id, false, "asc")}><ArrowUp /> Sort ascending</ContextMenuItem>
                  <ContextMenuItem onSelect={() => toggleSort(meta.name, h.column.id, false, "desc")}><ArrowDown /> Sort descending</ContextMenuItem>
                  <ContextMenuItem onSelect={() => toggleSort(meta.name, h.column.id, true, "asc")}>Add to sort (asc)</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => copyText(meta.name)}><Copy /> Copy column name</ContextMenuItem>
                  {onHide && <ContextMenuItem onSelect={() => onHide(meta.name)}><EyeOff /> Hide column</ContextMenuItem>}
                  <ContextMenuItem onSelect={() => h.column.resetSize()}>Reset width</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        {/* Body */}
        {modelRows.length === 0 ? (
          <div className="sticky left-0 flex h-40 w-full items-center justify-center font-sans text-muted-foreground" style={{ maxWidth: scrollRef.current?.clientWidth }}>
            {empty ?? "No rows"}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((vi) => {
              const row = modelRows[vi.index];
              const dataRow = row.index;
              return (
                <GridRow
                  key={vi.key}
                  top={vi.start}
                  viewIdx={vi.index}
                  dataRow={dataRow}
                  rowNumber={rowNumberOffset + dataRow + 1}
                  cells={visibleCols.map((c) => {
                    const ci = Number(c.id.split(":")[0]);
                    return { ci, width: c.getSize(), value: valueAt(dataRow, ci), edited: !!edits[dataRow] && columns[ci].name in edits[dataRow] };
                  })}
                  columns={columns}
                  selected={!!selected?.has(dataRow)}
                  isDeleted={!!deleted?.has(dataRow)}
                  activeCol={active?.r === vi.index ? active.c : -1}
                  editingCol={editing?.r === vi.index ? editing.c : -1}
                  onCellClick={(c) => setActive({ r: vi.index, c })}
                  onCellDoubleClick={(c) => {
                    setActive({ r: vi.index, c });
                    if (editable && !deleted?.has(dataRow)) setEditing({ r: vi.index, c });
                    else setViewer({ column: columns[colIndex(c)].name, value: valueAt(dataRow, colIndex(c)) });
                  }}
                  onRowNumberClick={(e) => selectRow(dataRow, vi.index, e)}
                  onCommit={(c, v) => {
                    setEditing(null);
                    const ci = colIndex(c);
                    const original = rows[dataRow][ci];
                    if (v !== undefined) {
                      const unchanged = original === null || original === undefined ? v === "" : cellToText(original) === v;
                      onEdit?.(dataRow, columns[ci].name, unchanged ? undefined : v);
                    }
                    scrollRef.current?.focus();
                  }}
                  menu={(c) => {
                    const ci = colIndex(c);
                    const col = columns[ci];
                    const value = valueAt(dataRow, ci);
                    const targets = selectedRows(dataRow).includes(dataRow) ? selectedRows(dataRow) : [dataRow];
                    return (
                      <>
                        <ContextMenuItem onSelect={() => copyText(cellToText(value), "Copied cell")}><Copy /> Copy value</ContextMenuItem>
                        <ContextMenuItem onSelect={() => setViewer({ column: col.name, value })}><Maximize2 /> View value</ContextMenuItem>
                        <ContextMenuSub>
                          <ContextMenuSubTrigger><Copy /> Copy {targets.length > 1 ? `${targets.length} rows` : "row"} as</ContextMenuSubTrigger>
                          <ContextMenuSubContent>
                            <ContextMenuItem onSelect={() => copyRows(targets, "tsv")}>Tab-separated</ContextMenuItem>
                            <ContextMenuItem onSelect={() => copyRows(targets, "csv")}>CSV</ContextMenuItem>
                            <ContextMenuItem onSelect={() => copyRows(targets, "json")}>JSON</ContextMenuItem>
                            {insertSql && <ContextMenuItem onSelect={() => copyRows(targets, "sql")}>SQL INSERT</ContextMenuItem>}
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                        {onFilterValue && (
                          <>
                            <ContextMenuSeparator />
                            {value === null ? (
                              <ContextMenuItem onSelect={() => onFilterValue(col.name, "is_null", null)}><Filter /> Filter: {col.name} IS NULL</ContextMenuItem>
                            ) : (
                              <>
                                <ContextMenuItem onSelect={() => onFilterValue(col.name, "eq", value)}><Filter /> Filter: = this value</ContextMenuItem>
                                <ContextMenuItem onSelect={() => onFilterValue(col.name, "neq", value)}><FilterX /> Filter: ≠ this value</ContextMenuItem>
                              </>
                            )}
                          </>
                        )}
                        {editable && !deleted?.has(dataRow) && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => setEditing({ r: vi.index, c })}>Edit cell <span className="ml-auto kbd">Enter</span></ContextMenuItem>
                            {col.nullable !== false && <ContextMenuItem onSelect={() => onEdit?.(dataRow, col.name, null)}>Set NULL</ContextMenuItem>}
                            <ContextMenuItem onSelect={() => onEdit?.(dataRow, col.name, "")}>Set empty string</ContextMenuItem>
                          </>
                        )}
                        {(edits[dataRow] || deleted?.has(dataRow)) && onRevertRows && (
                          <ContextMenuItem onSelect={() => onRevertRows(targets)}><Undo2 /> Revert changes</ContextMenuItem>
                        )}
                        {editable && onDeleteRows && !deleted?.has(dataRow) && (
                          <ContextMenuItem variant="destructive" onSelect={() => onDeleteRows(targets)}>
                            <Trash2 /> Delete {targets.length > 1 ? `${targets.length} rows` : "row"}
                          </ContextMenuItem>
                        )}
                      </>
                    );
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
      <ValueViewer viewer={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}

interface RowProps {
  top: number;
  viewIdx: number;
  dataRow: number;
  rowNumber: number;
  cells: { ci: number; width: number; value: CellValue; edited: boolean }[];
  columns: GridColumn[];
  selected: boolean;
  isDeleted: boolean;
  activeCol: number;
  editingCol: number;
  onCellClick: (c: number) => void;
  onCellDoubleClick: (c: number) => void;
  onRowNumberClick: (e: React.MouseEvent) => void;
  onCommit: (c: number, v: string | undefined) => void;
  menu: (c: number) => React.ReactNode;
}

const GridRow = memo(function GridRow(p: RowProps) {
  return (
    <div
      role="row"
      className={cn(
        "absolute left-0 flex w-full border-b border-grid",
        p.viewIdx % 2 === 1 && "bg-surface/60",
        p.selected && "bg-primary/12!",
        p.isDeleted && "bg-destructive/10! text-muted-foreground line-through",
      )}
      style={{ top: p.top, height: ROW_H }}
    >
      <div
        onClick={p.onRowNumberClick}
        className={cn(
          "sticky left-0 z-10 flex shrink-0 cursor-pointer items-center justify-end border-r bg-surface pr-2 text-[10.5px] text-muted-foreground/80 tabular-nums hover:text-foreground",
          p.selected && "bg-primary/20 text-foreground",
        )}
        style={{ width: NUM_W }}
      >
        {p.rowNumber}
      </div>
      {p.cells.map((cell, c) => {
        const col = p.columns[cell.ci];
        const isActive = p.activeCol === c;
        return (
          <ContextMenu key={cell.ci}>
            <ContextMenuTrigger asChild>
              <div
                role="gridcell"
                onMouseDown={() => p.onCellClick(c)}
                onDoubleClick={() => p.onCellDoubleClick(c)}
                className={cn(
                  "relative flex shrink-0 items-center overflow-hidden border-r border-grid px-2 whitespace-nowrap",
                  isNumeric(col.category) && "justify-end",
                  cell.edited && "bg-warning/15",
                  isActive && "outline-2 -outline-offset-2 outline-primary/70",
                )}
                style={{ width: cell.width }}
              >
                {p.editingCol === c ? (
                  <CellEditor initial={cell.value} category={col.category} onDone={(v) => p.onCommit(c, v)} />
                ) : (
                  <span className="truncate">
                    <CellValueView value={cell.value} category={col.category} />
                  </span>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56 font-sans">{p.menu(c)}</ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
});

const EDITOR_CLASS = "absolute inset-0 z-10 w-full bg-background px-2 font-mono text-[12px] outline-2 -outline-offset-2 outline-primary";

function CellEditor({ initial, category, onDone }: { initial: CellValue; category: TypeCategory; onDone: (v: string | undefined) => void }) {
  const text = initial === null || initial === undefined ? "" : typeof initial === "object" ? JSON.stringify(initial) : String(initial);
  const [value, setValue] = useState(text);
  const multiline = category === "json" || text.length > 80 || text.includes("\n");
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);
  const finish = (v: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const common = {
    ref,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setValue(e.target.value),
    onBlur: () => finish(value),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") finish(undefined);
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(value);
      }
    },
  };
  if (multiline) return <textarea {...common} rows={1} className={cn(EDITOR_CLASS, "absolute top-0 h-[120px] resize-none py-1 shadow-lg")} />;
  return <input {...common} className={EDITOR_CLASS} />;
}

function ValueViewer({ viewer, onClose }: { viewer: { column: string; value: CellValue } | null; onClose: () => void }) {
  return (
    <Dialog open={!!viewer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="font-sans sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{viewer?.column}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md border bg-surface p-3 font-mono text-[12px] whitespace-pre-wrap break-all">
          {viewer ? prettyValue(viewer.value) : ""}
        </pre>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => viewer && copyText(prettyValue(viewer.value))}>
            <Copy /> Copy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function compareValues(a: CellValue, b: CellValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a === "string" && typeof b === "string" && a.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return cellToText(a).localeCompare(cellToText(b));
}
