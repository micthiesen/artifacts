import { useState } from "react";
import { Avatar, Input } from "@a/ui";
import { useSharedMap, useViewer } from "@a/hooks";
import { ThumbsUp } from "lucide-react";

type Card = { col: string; text: string; by: string | null };
const COLUMNS = ["Went well", "To improve", "Actions"];

export default function Retro() {
  const cards = useSharedMap<Card>("card");
  const votes = useSharedMap<boolean>("vote"); // vote/<card>/<email>
  const { email, canWrite } = useViewer();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const count = (id: string) => votes.entries.filter(([k]) => k.startsWith(`${id}/`)).length;
  const mine = (id: string) => votes.get(`${id}/${email}`);

  function add(col: string) {
    const text = drafts[col]?.trim();
    if (!text || !canWrite) return;
    cards.set(crypto.randomUUID(), { col, text, by: email });
    setDrafts({ ...drafts, [col]: "" });
  }
  function vote(id: string) {
    const key = `${id}/${email}`;
    mine(id) ? votes.delete(key) : votes.set(key, true);
  }

  return (
    <div className="grid min-h-full content-start gap-4 px-5 pt-5 pb-20 sm:grid-cols-3">
      {COLUMNS.map((col) => (
        <section key={col} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{col}</h2>
          {cards.entries
            .filter(([, c]) => c.col === col)
            .sort((a, b) => count(b[0]) - count(a[0]))
            .map(([id, c]) => (
              <div key={id} className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm">
                <Avatar email={c.by ?? undefined} size="sm" />
                <span className="flex-1">{c.text}</span>
                <button
                  className={`flex items-center gap-1 text-xs ${mine(id) ? "text-primary" : "text-muted-foreground"}`}
                  disabled={!canWrite}
                  onClick={() => vote(id)}
                >
                  <ThumbsUp className="size-3.5" /> {count(id)}
                </button>
              </div>
            ))}
          <Input
            placeholder="Add a card…"
            value={drafts[col] ?? ""}
            disabled={!canWrite}
            onChange={(e) => setDrafts({ ...drafts, [col]: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && add(col)}
          />
        </section>
      ))}
    </div>
  );
}
