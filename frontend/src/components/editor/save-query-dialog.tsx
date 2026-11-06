"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function SaveQueryDialog({
  open, onOpenChange, defaultName, onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultName: string;
  onSave: (name: string, description: string | null, isSnippet: boolean) => Promise<void>;
}) {
  return open ? <Inner onOpenChange={onOpenChange} defaultName={defaultName} onSave={onSave} /> : null;
}

function Inner({ onOpenChange, defaultName, onSave }: { onOpenChange: (o: boolean) => void; defaultName: string; onSave: (name: string, description: string | null, isSnippet: boolean) => Promise<void> }) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [snippet, setSnippet] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onSave(name.trim(), description.trim() || null, snippet);
              onOpenChange(false);
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Save query</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="sq-name">Name</Label>
            <Input id="sq-name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily active users" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sq-desc">Description</Label>
            <Textarea id="sq-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox checked={snippet} onCheckedChange={(v) => setSnippet(v === true)} />
            Save as snippet (insertable from the Snippets menu)
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
