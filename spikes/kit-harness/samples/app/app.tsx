import { useState } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label, Popover, PopoverContent, PopoverTrigger, Progress, Select, Slider, Switch, Tooltip, Avatar, Kbd, Separator, Skeleton } from "@a/ui";
import { useLocal, usePresence, useShared, useSharedMap, useViewer } from "@a/hooks";
import { Plus, Sparkles, Trash2 } from "lucide-react";

type Todo = { text: string; done: boolean; by: string | null; at: number };

export default function App() {
  const viewer = useViewer();
  const presence = usePresence();
  const todos = useSharedMap<Todo>("todo");
  const [goal, setGoal] = useShared("goal", 5);
  const [compact, setCompact] = useLocal("compact", false);
  const [filter, setFilter] = useLocal<string>("filter", "all");
  const [draft, setDraft] = useState("");
  const add = () => { if (!draft.trim()) return; todos.set(`${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, { text: draft.trim(), done: false, by: viewer.email, at: Date.now() }); setDraft(""); };
  const done = todos.entries.filter(([, t]) => t.done).length;
  const shown = todos.entries.filter(([, t]) => filter === "all" || (filter === "open" ? !t.done : t.done));

  return (
    <div className="flex h-full flex-col bg-muted/40">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-background px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Team board</h1>
          <p className="text-sm text-muted-foreground">Signed in as {viewer.email ?? "anonymous"} · <Badge tone={viewer.canWrite ? "positive" : "neutral"}>{viewer.role}</Badge></p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex -space-x-1.5">{presence.map((p) => <Tooltip key={p} content={p}><span><Avatar email={p} size="sm" /></span></Tooltip>)}</div>
          <Popover>
            <PopoverTrigger><Sparkles /> Tips</PopoverTrigger>
            <PopoverContent>Press <Kbd>⏎</Kbd> to add. Everything syncs live for everyone viewing.</PopoverContent>
          </Popover>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-5xl flex-1 gap-6 overflow-auto p-6 md:grid-cols-[1fr_18rem]">
        <Card>
          <CardHeader>
            <CardTitle>Tasks</CardTitle>
            <CardDescription>{done} of {todos.entries.length} done · goal {goal}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex gap-2">
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add a task…" disabled={!viewer.canWrite} />
              <Button onClick={add} disabled={!viewer.canWrite || !draft.trim()}><Plus /> Add</Button>
            </div>
            <Select options={[{ value: "all", label: "All tasks" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }]} value={filter} onValueChange={(v) => setFilter(String(v))} />
            <ul className={compact ? "flex flex-col gap-1" : "flex flex-col gap-2"}>
              {shown.map(([k, t]) => (
                <li key={k} className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
                  <Checkbox checked={t.done} disabled={!viewer.canWrite} onCheckedChange={(c) => todos.set(k, { ...t, done: c })} />
                  <span className={t.done ? "flex-1 text-muted-foreground line-through" : "flex-1"}>{t.text}</span>
                  <Button variant="ghost" size="icon-sm" aria-label="Delete" disabled={!viewer.canWrite} onClick={() => todos.delete(k)}><Trash2 /></Button>
                </li>
              ))}
              {shown.length === 0 && <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{todos.entries.length === 0 ? "No tasks yet. Add the first one above." : "No tasks match this filter."}</li>}
            </ul>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><CardTitle>Progress</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Progress value={Math.min(100, (done / Math.max(1, goal)) * 100)} label="Toward goal" />
              <Label>Goal: {goal}</Label>
              <Slider value={goal} min={1} max={20} onValueChange={(v) => setGoal(Number(v))} disabled={!viewer.canWrite} />
              <Separator className="my-1" />
              <Switch checked={compact} onCheckedChange={setCompact} label="Compact list (just for me)" />
            </CardContent>
          </Card>
          <Dialog>
            <DialogTrigger render={<Button variant="destructive" />} disabled={!viewer.canWrite}>Clear done</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear finished tasks?</DialogTitle>
                <DialogDescription>This removes {done} tasks for everyone.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="destructive" onClick={() => todos.entries.forEach(([k, t]) => t.done && todos.delete(k))}>Clear</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </div>
  );
}
