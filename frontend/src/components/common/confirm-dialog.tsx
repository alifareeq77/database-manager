"use client";

import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useUi } from "@/stores/ui";

export function ConfirmDialog() {
  const req = useUi((s) => s.confirm);
  return req ? <ConfirmInner key={req.title} /> : null;
}

function ConfirmInner() {
  const req = useUi((s) => s.confirm)!;
  const [typed, setTyped] = useState("");
  const blocked = !!req.typeToConfirm && typed !== req.typeToConfirm;
  return (
    <AlertDialog open onOpenChange={(o) => !o && req.resolve(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{req.title}</AlertDialogTitle>
          {req.description && <AlertDialogDescription asChild><div>{req.description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        {req.typeToConfirm && (
          <div className="space-y-1.5">
            <p className="text-[12px] text-muted-foreground">
              Type <code className="rounded bg-muted px-1 font-mono text-foreground">{req.typeToConfirm}</code> to confirm.
            </p>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => req.resolve(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={blocked}
            className={req.destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
            onClick={(e) => {
              e.preventDefault();
              if (!blocked) req.resolve(true);
            }}
          >
            {req.confirmText ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
