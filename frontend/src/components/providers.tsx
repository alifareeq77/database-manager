"use client";

import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
      <TooltipProvider delayDuration={400}>
        {children}
        <Toaster position="bottom-right" closeButton toastOptions={{ className: "text-[13px]" }} />
      </TooltipProvider>
    </ThemeProvider>
  );
}
