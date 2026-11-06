"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { AuthStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";

export function AuthScreen({ setup, onAuthenticated }: { setup: boolean; onAuthenticated: (s: AuthStatus) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (setup && password !== confirm) return setError("Passwords do not match");
    setBusy(true);
    try {
      onAuthenticated(setup ? await api.auth.setup(username, password) : await api.auth.login(username, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background p-4">
      <div className="w-full max-w-[340px]">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-6" />
          <span className="text-base font-semibold tracking-tight">Strata</span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight">{setup ? "Create the admin account" : "Sign in"}</h1>
        <p className="mt-1 text-muted-foreground">
          {setup ? "This account manages connections and can review the audit log." : "Use your Strata account to continue."}
        </p>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="u">Username</Label>
            <Input id="u" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p">Password</Label>
            <Input id="p" type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup ? 10 : 1} />
            {setup && <p className="text-[11px] text-muted-foreground">At least 10 characters.</p>}
          </div>
          {setup && (
            <div className="space-y-1.5">
              <Label htmlFor="c">Confirm password</Label>
              <Input id="c" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
          )}
          {error && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {setup ? "Create account" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
