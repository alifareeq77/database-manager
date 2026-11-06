import { useEffect, useRef } from "react";

/**
 * Register a global keyboard shortcut. `combo` uses "mod" for Ctrl/⌘, e.g. "mod+k", "alt+n", "mod+shift+f".
 * Shortcuts fire even inside inputs unless `allowInInputs` is false.
 */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, opts: { allowInInputs?: boolean; enabled?: boolean } = {}) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  const { allowInInputs = true, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    const want = { mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod !== want.mod || e.shiftKey !== want.shift || e.altKey !== want.alt) return;
      const k = e.key.toLowerCase();
      const code = e.code.toLowerCase();
      if (k !== key && code !== `key${key}` && code !== `digit${key}`) return;
      if (!allowInInputs) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      }
      e.preventDefault();
      ref.current(e);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [combo, allowInInputs, enabled]);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";
