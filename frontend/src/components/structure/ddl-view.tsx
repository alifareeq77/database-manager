"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Copy, RefreshCw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { matchesTable, onObjectsChanged } from "@/lib/events";
import type { Connection, ObjectKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";
import { copyText } from "@/components/explorer/object-actions";

const KEYWORDS = /\b(CREATE|TABLE|VIEW|MATERIALIZED|INDEX|UNIQUE|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|NOT|NULL|DEFAULT|CHECK|ON|DELETE|UPDATE|CASCADE|RESTRICT|SET|NO|ACTION|AS|SELECT|FROM|WHERE|JOIN|LEFT|INNER|AND|OR|USING|IF|EXISTS|ALTER|ADD|COMMENT|IS|ENGINE|CHARSET|COLLATE|AUTO_INCREMENT|GENERATED|ALWAYS|IDENTITY|BY|WITH|TRIGGER|BEFORE|AFTER|FOR|EACH|ROW|EXECUTE|FUNCTION|PROCEDURE|RETURNS|BEGIN|END|SEQUENCE|INCREMENT|START|CACHE|OWNED)\b/g;

/** Read-only DDL with light keyword highlighting; editing happens in a query tab. */
export function DdlView({ conn, database, schema, name, kind }: { conn: Connection; database: string | null; schema: string | null; name: string; kind: ObjectKind }) {
  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSql((await api.explorer.ddl(conn.id, database, schema, name, kind)).sql);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conn.id, database, schema, name, kind]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / target change
    void load();
  }, [load]);
  useEffect(() => onObjectsChanged((d) => matchesTable(d, conn.id, database, schema, name) && void load()), [conn.id, database, schema, name, load]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw className={cn(loading && "animate-spin")} /> Refresh</Button>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" disabled={!sql} onClick={() => sql && copyText(sql, "DDL copied")}><Copy /> Copy</Button>
          <Button variant="ghost" size="sm" disabled={!sql} onClick={() => sql && useWorkspace.getState().openQuery(conn.id, database, sql, `DDL ${name}`)}>
            <SquareTerminal /> Open in editor
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertCircle className="size-5 text-destructive" />
            <p className="max-w-lg break-words text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        ) : sql === null ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-4" style={{ width: `${40 + ((i * 37) % 50)}%` }} />)}</div>
        ) : (
          <pre className="p-4 font-mono text-[12.5px] leading-5 whitespace-pre">
            <Highlighted sql={sql} />
          </pre>
        )}
      </div>
    </div>
  );
}

function Highlighted({ sql }: { sql: string }) {
  // Split on string literals and comments first so keywords inside them are left alone.
  const parts = sql.split(/('(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 1) {
          return <span key={i} className={p.startsWith("'") ? "text-syntax-string" : "text-muted-foreground italic"}>{p}</span>;
        }
        const out: React.ReactNode[] = [];
        let last = 0;
        for (const m of p.matchAll(KEYWORDS)) {
          if (m.index! > last) out.push(p.slice(last, m.index));
          out.push(<span key={`${i}-${m.index}`} className="font-medium text-primary">{m[0]}</span>);
          last = m.index! + m[0].length;
        }
        out.push(p.slice(last));
        return <span key={i}>{out}</span>;
      })}
    </>
  );
}
