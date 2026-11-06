"use client";

import { createContext, useContext } from "react";
import type { User } from "@/lib/types";

interface Session {
  user: User;
  onLogout: () => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ user, onLogout, children }: Session & { children: React.ReactNode }) {
  return <Ctx.Provider value={{ user, onLogout }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
