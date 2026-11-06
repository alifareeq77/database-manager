"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  History, LogOut, Moon, PanelLeftClose, Plus, ScrollText, Search, Sun, SquareTerminal, KeyRound, LayoutDashboard, X,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConnectionSelector } from "@/components/connections/connection-selector";
import { ExplorerTree } from "@/components/explorer/explorer-tree";
import { SavedQueriesList } from "@/components/editor/saved-queries-list";
import { ChangePasswordDialog } from "@/components/auth/change-password-dialog";
import { useActiveConnection } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useSession } from "@/components/session-context";
import { api } from "@/lib/api";
import { modKey } from "@/hooks/use-hotkey";

export function Sidebar() {
  const conn = useActiveConnection();
  const [filter, setFilter] = useState("");
  const { theme, setTheme } = useTheme();
  const { user, onLogout } = useSession();
  const [pwOpen, setPwOpen] = useState(false);

  return (
    <aside className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Logo className="size-[18px]" />
        <span className="font-semibold tracking-tight">Strata</span>
        <div className="ml-auto flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => useUi.getState().setPalette(true)} aria-label="Command palette">
                <Search />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Command palette <span className="kbd ml-1">{modKey} K</span></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={() => useUi.getState().toggleSidebar()} aria-label="Hide sidebar">
                <PanelLeftClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide sidebar <span className="kbd ml-1">{modKey} B</span></TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="space-y-2 border-b p-2">
        <ConnectionSelector />
        {conn && (
          <div className="flex gap-1">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter objects"
                className="h-7 pl-7 text-[12px]"
                onKeyDown={(e) => e.key === "Escape" && setFilter("")}
              />
              {filter && (
                <button className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setFilter("")} aria-label="Clear filter">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" className="size-7" aria-label="New query" onClick={() => useWorkspace.getState().openQuery(conn.id, conn.database)}>
                  <SquareTerminal />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New query <span className="kbd ml-1">Alt N</span></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon-sm" className="size-7" aria-label="Overview"
                  onClick={() => useWorkspace.getState().open({ id: `dashboard:${conn.id}`, kind: "dashboard", connectionId: conn.id, database: conn.database })}>
                  <LayoutDashboard />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Connection overview</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {conn ? (
          <ExplorerTree key={conn.id} connection={conn} filter={filter} />
        ) : (
          <div className="px-4 py-10 text-center">
            <p className="font-medium">No connection selected</p>
            <p className="mt-1 text-muted-foreground">Add a PostgreSQL, MySQL or SQLite connection to start exploring.</p>
            <Button size="sm" className="mt-4" onClick={() => useUi.getState().openConnectionDialog()}>
              <Plus /> New connection
            </Button>
          </div>
        )}
      </div>

      <SavedQueriesList />

      <div className="flex h-9 shrink-0 items-center gap-0.5 border-t px-1.5">
        <SidebarIcon label="Query history" onClick={() => useWorkspace.getState().open({ id: "history", kind: "history" })}>
          <History />
        </SidebarIcon>
        <SidebarIcon label="Audit log" onClick={() => useWorkspace.getState().open({ id: "audit", kind: "audit" })}>
          <ScrollText />
        </SidebarIcon>
        <SidebarIcon label={theme === "dark" ? "Light theme" : "Dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </SidebarIcon>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="ml-auto flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary uppercase">{user.username.slice(0, 2)}</span>
              <span className="max-w-24 truncate text-[12px]">{user.username}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-48">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
              Signed in as {user.username} · {user.role}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPwOpen(true)}>
              <KeyRound /> Change password
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                try {
                  await api.auth.logout();
                } catch (e) {
                  toast.error((e as Error).message);
                }
                onLogout();
              }}
            >
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </aside>
  );
}

function SidebarIcon({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
