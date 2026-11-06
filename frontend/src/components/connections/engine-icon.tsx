import { cn } from "@/lib/utils";
import type { Engine } from "@/lib/types";

const LABEL: Record<Engine, string> = { postgresql: "PG", mysql: "MY", sqlite: "SL" };
export const ENGINE_NAME: Record<Engine, string> = { postgresql: "PostgreSQL", mysql: "MySQL / MariaDB", sqlite: "SQLite" };

/** Compact monogram badge; tinted with the connection's color when one is set. */
export function EngineBadge({ engine, color, className }: { engine: Engine; color?: string | null; className?: string }) {
  return (
    <span
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-[9px] font-semibold", className)}
      style={{
        background: color ? `color-mix(in oklch, ${color} 22%, transparent)` : "var(--surface-2)",
        color: color ?? "var(--muted-foreground)",
        boxShadow: `inset 0 0 0 1px ${color ? `color-mix(in oklch, ${color} 40%, transparent)` : "var(--border)"}`,
      }}
      aria-label={ENGINE_NAME[engine]}
    >
      {LABEL[engine]}
    </span>
  );
}

export function StatusDot({ status }: { status: string | undefined }) {
  const cls =
    status === "connected" ? "bg-success" : status === "connecting" ? "bg-warning animate-pulse" : status === "error" ? "bg-destructive" : "bg-muted-foreground/40";
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", cls)} />;
}
