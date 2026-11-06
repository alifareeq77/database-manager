"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, onUnauthorized } from "@/lib/api";
import type { AuthStatus } from "@/lib/types";
import { AuthScreen } from "@/components/auth/auth-screen";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { SessionProvider } from "@/components/session-context";

export function AppRoot() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.auth.status());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial auth probe
    void refresh();
    onUnauthorized(() => setStatus((s) => (s ? { ...s, user: null } : s)));
  }, [refresh]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium">Cannot reach the Strata backend</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
          <button className="mt-4 text-primary hover:underline" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (!status.user) return <AuthScreen setup={status.setup_required} onAuthenticated={setStatus} />;
  return (
    <SessionProvider user={status.user} onLogout={() => setStatus({ ...status, user: null })}>
      <WorkspaceShell />
    </SessionProvider>
  );
}
