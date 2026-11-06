"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { ConnectionInput, Engine, ServerInfo, SslMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { EngineBadge, ENGINE_NAME } from "./engine-icon";

const COLORS = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7", "#14b8a6", "#64748b"];
const DEFAULT_PORT: Record<Engine, number | null> = { postgresql: 5432, mysql: 3306, sqlite: null };

const EMPTY: ConnectionInput = {
  name: "", engine: "postgresql", group: "", color: COLORS[0], host: "localhost", port: null, username: "", password: "",
  database: "", ssl_mode: "prefer", ssl_ca: "", params: {}, read_only: false, query_timeout_s: null,
};

export function ConnectionDialog() {
  const { open, editId } = useUi((s) => s.connectionDialog);
  const close = useUi((s) => s.closeConnectionDialog);
  const existing = useConnections((s) => s.connections.find((c) => c.id === editId));
  const groups = useConnections((s) => [...new Set(s.connections.map((c) => c.group).filter(Boolean))] as string[]);

  const [form, setForm] = useState<ConnectionInput>(EMPTY);
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [params, setParams] = useState<[string, string][]>([]);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: true; info: ServerInfo } | { ok: false; error: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset form when the dialog opens */
    setTest(null);
    if (existing) {
      setForm({
        name: existing.name, engine: existing.engine, group: existing.group ?? "", color: existing.color, host: existing.host,
        port: existing.port, username: existing.username ?? "", password: null, database: existing.database ?? "",
        ssl_mode: existing.ssl_mode, ssl_ca: "", params: existing.params, read_only: existing.read_only, query_timeout_s: existing.query_timeout_s,
      });
      setHasStoredPassword(existing.has_password);
      setParams(Object.entries(existing.params));
    } else {
      setForm(EMPTY);
      setHasStoredPassword(false);
      setParams([]);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, existing]);

  const set = <K extends keyof ConnectionInput>(k: K, v: ConnectionInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isSqlite = form.engine === "sqlite";

  function payload(): ConnectionInput {
    return {
      ...form,
      name: form.name.trim() || (isSqlite ? form.database || "SQLite" : `${form.host}${form.database ? `/${form.database}` : ""}`),
      group: form.group?.trim() || null,
      host: isSqlite ? null : form.host?.trim() || null,
      port: isSqlite ? null : form.port || null,
      username: isSqlite ? null : form.username || null,
      password: isSqlite ? null : form.password,
      database: form.database?.trim() || null,
      ssl_ca: form.ssl_ca?.trim() || null,
      params: Object.fromEntries(params.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
      query_timeout_s: form.query_timeout_s || null,
    };
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const info = await api.connections.test({ ...payload(), connection_id: existing?.id });
      setTest({ ok: true, info });
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = existing ? await api.connections.update(existing.id, payload()) : await api.connections.create(payload());
      const store = useConnections.getState();
      store.upsert(saved);
      store.invalidateCatalog(saved.id);
      store.setActive(saved.id);
      void store.connect(saved.id);
      toast.success(existing ? "Connection updated" : "Connection saved");
      close();
    } catch (err) {
      toast.error("Could not save connection", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]">
        <form onSubmit={save}>
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>{existing ? "Edit connection" : "New connection"}</DialogTitle>
            <DialogDescription>Credentials are encrypted at rest on the server and never sent back to the browser.</DialogDescription>
          </DialogHeader>

          <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
            <div className="mb-4 grid grid-cols-3 gap-2">
              {(["postgresql", "mysql", "sqlite"] as Engine[]).map((eng) => (
                <button
                  type="button"
                  key={eng}
                  onClick={() => setForm((f) => ({ ...f, engine: eng, port: null, ssl_mode: eng === "sqlite" ? "disable" : f.ssl_mode }))}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                    form.engine === eng ? "border-primary/60 bg-primary/8" : "hover:bg-accent/60",
                  )}
                >
                  <EngineBadge engine={eng} color={form.engine === eng ? form.color : null} />
                  <span className="text-[12px]">{ENGINE_NAME[eng]}</span>
                </button>
              ))}
            </div>

            <Tabs defaultValue="general">
              <TabsList className="mb-3">
                <TabsTrigger value="general">General</TabsTrigger>
                {!isSqlite && <TabsTrigger value="ssl">SSL</TabsTrigger>}
                <TabsTrigger value="advanced">Advanced</TabsTrigger>
              </TabsList>

              <TabsContent value="general" className="space-y-3">
                <div className="grid grid-cols-[1fr_160px] gap-3">
                  <Field label="Name">
                    <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Production replica" autoFocus />
                  </Field>
                  <Field label="Group">
                    <Input value={form.group ?? ""} onChange={(e) => set("group", e.target.value)} placeholder="None" list="conn-groups" />
                    <datalist id="conn-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
                  </Field>
                </div>
                <Field label="Color">
                  <div className="flex gap-1.5">
                    {COLORS.map((c) => (
                      <button
                        type="button"
                        key={c}
                        aria-label={`Color ${c}`}
                        onClick={() => set("color", c)}
                        className={cn("size-5 rounded-full ring-offset-2 ring-offset-background transition", form.color === c && "ring-2 ring-ring")}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                </Field>

                {isSqlite ? (
                  <Field label="Database file" hint="Path relative to the server's SQLite directory (STRATA_SQLITE_ROOT). A new file is created if it does not exist.">
                    <Input value={form.database ?? ""} onChange={(e) => set("database", e.target.value)} placeholder="app.db" required />
                  </Field>
                ) : (
                  <>
                    <div className="grid grid-cols-[1fr_110px] gap-3">
                      <Field label="Host">
                        <Input value={form.host ?? ""} onChange={(e) => set("host", e.target.value)} placeholder="localhost" required />
                      </Field>
                      <Field label="Port">
                        <Input
                          type="number"
                          value={form.port ?? ""}
                          onChange={(e) => set("port", e.target.value ? Number(e.target.value) : null)}
                          placeholder={String(DEFAULT_PORT[form.engine])}
                        />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="User">
                        <Input value={form.username ?? ""} onChange={(e) => set("username", e.target.value)} autoComplete="off" />
                      </Field>
                      <Field label="Password">
                        <div className="flex gap-1">
                          <Input
                            type="password"
                            autoComplete="new-password"
                            value={form.password ?? ""}
                            onChange={(e) => {
                              set("password", e.target.value);
                              set("clear_password", false);
                            }}
                            placeholder={hasStoredPassword && form.password === null && !form.clear_password ? "•••••••• (stored)" : ""}
                          />
                          {hasStoredPassword && !form.clear_password && (
                            <Button type="button" variant="ghost" size="icon" title="Remove stored password" onClick={() => setForm((f) => ({ ...f, password: null, clear_password: true }))}>
                              <Trash2 />
                            </Button>
                          )}
                        </div>
                      </Field>
                    </div>
                    <Field label="Database" hint={form.engine === "postgresql" ? "Defaults to “postgres”." : "Optional; leave empty to browse all databases."}>
                      <Input value={form.database ?? ""} onChange={(e) => set("database", e.target.value)} />
                    </Field>
                  </>
                )}
              </TabsContent>

              {!isSqlite && (
                <TabsContent value="ssl" className="space-y-3">
                  <Field label="SSL mode">
                    <Select value={form.ssl_mode} onValueChange={(v) => set("ssl_mode", v as SslMode)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(["disable", "prefer", "require", "verify-ca", "verify-full"] as SslMode[]).map((m) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="CA certificate (PEM)" hint={existing?.has_ssl_ca ? "A CA certificate is stored. Paste a new one to replace it." : "Required for verify-ca / verify-full with a private CA."}>
                    <Textarea rows={5} className="font-mono text-[11px]" value={form.ssl_ca ?? ""} onChange={(e) => set("ssl_ca", e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
                  </Field>
                </TabsContent>
              )}

              <TabsContent value="advanced" className="space-y-3">
                <label className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span>
                    <span className="flex items-center gap-1.5 font-medium"><ShieldCheck className="size-3.5" /> Read-only</span>
                    <span className="block text-[11px] text-muted-foreground">Enforced by the database session, not by filtering SQL.</span>
                  </span>
                  <Switch checked={form.read_only} onCheckedChange={(v) => set("read_only", v)} />
                </label>
                <Field label="Query timeout (seconds)" hint="Statements running longer are cancelled on the server.">
                  <Input type="number" min={1} max={3600} value={form.query_timeout_s ?? ""} onChange={(e) => set("query_timeout_s", e.target.value ? Number(e.target.value) : null)} placeholder="30" />
                </Field>
                {!isSqlite && (
                  <Field label="Connection parameters" hint={form.engine === "postgresql" ? "Sent as server settings, e.g. search_path, application_name." : "Allowed: charset, connect_timeout, sql_mode, time_zone."}>
                    <div className="space-y-1.5">
                      {params.map(([k, v], i) => (
                        <div key={i} className="flex gap-1.5">
                          <Input value={k} placeholder="name" className="font-mono text-[12px]" onChange={(e) => setParams((p) => p.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                          <Input value={v} placeholder="value" className="font-mono text-[12px]" onChange={(e) => setParams((p) => p.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                          <Button type="button" variant="ghost" size="icon" onClick={() => setParams((p) => p.filter((_, j) => j !== i))} aria-label="Remove parameter">
                            <Trash2 />
                          </Button>
                        </div>
                      ))}
                      <Button type="button" variant="outline" size="sm" onClick={() => setParams((p) => [...p, ["", ""]])}>
                        <Plus /> Add parameter
                      </Button>
                    </div>
                  </Field>
                )}
                <p className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
                  SSH tunnelling is not built in yet. Use an existing tunnel (e.g. <code className="font-mono">ssh -L 5433:db:5432 bastion</code>) and connect to localhost.
                </p>
              </TabsContent>
            </Tabs>

            {test && (
              <div className={cn("mt-4 flex items-start gap-2 rounded-md border px-3 py-2", test.ok ? "border-success/30 bg-success/8" : "border-destructive/30 bg-destructive/8")}>
                {test.ok ? <CheckCircle2 className="mt-0.5 size-4 text-success" /> : <XCircle className="mt-0.5 size-4 text-destructive" />}
                <div className="min-w-0 text-[12px]">
                  {test.ok ? (
                    <>
                      <div className="font-medium">Connected · {test.info.latency_ms.toFixed(0)} ms</div>
                      <div className="text-muted-foreground">{test.info.version}{test.info.current_user ? ` as ${test.info.current_user}` : ""}</div>
                    </>
                  ) : (
                    <div className="break-words text-destructive">{test.error}</div>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="border-t px-5 py-3 sm:justify-between">
            <Button type="button" variant="outline" onClick={runTest} disabled={testing}>
              {testing && <Loader2 className="animate-spin" />} Test connection
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="animate-spin" />} {existing ? "Save changes" : "Save connection"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
