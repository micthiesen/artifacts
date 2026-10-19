// A support case's page (in the operator's support workspace, shared with the
// person who reported it): what they reported, where it stands, and, once a fix
// is out, whether it helped. The conversation is the page's comment thread. The
// status (`case/status`) is written only by the service, never from the page.
import * as React from "react";
import { useData, useShared, useViewer } from "../hooks.ts";
import { post } from "../store.ts";
import { Badge, Button } from "./primitives.tsx";
import { cn, displayName, relativeTime, useNow } from "./utils.ts";

type CaseData = {
  number: number;
  kind: "bug" | "feature" | "question";
  title: string;
  reporter: string;
  submittedAt: string;
  viaAgent?: boolean;
  context?: { workspace?: string; page?: string; browser?: string; version?: string };
  error?: { id: string; message: string } | null;
};
type CaseStatus = {
  status: string;
  at?: string;
  thread?: string;
  history?: { status: string; at: string }[];
  fix?: { summary?: string; version?: string };
};

const STATUS: Record<string, { label: string; tone: "neutral" | "positive" | "caution"; text: string }> = {
  new: { label: "Received", tone: "neutral", text: "We have it. Replies show up in the conversation, and we'll let you know when something changes." },
  triaged: { label: "Looking into it", tone: "neutral", text: "We're looking into it." },
  investigating: { label: "Looking into it", tone: "neutral", text: "We're looking into it." },
  needs_info: { label: "Waiting for you", tone: "caution", text: "We've asked something in the conversation. Reply there when you can." },
  fix_proposed: { label: "Fix in progress", tone: "neutral", text: "A fix is being made and reviewed." },
  fix_deployed: { label: "Fix released", tone: "positive", text: "A fix is out. Does it work for you now?" },
  resolved: { label: "Resolved", tone: "positive", text: "This is resolved. If it comes back, reply in the conversation and we'll pick it up again." },
  wont_fix: { label: "Closed", tone: "neutral", text: "Closed without a change; the conversation says why." },
  duplicate: { label: "Being handled with another report", tone: "neutral", text: "Someone reported the same thing, and we're working on it together. You'll hear about it here." },
};
const KIND = { bug: "Problem", feature: "Idea", question: "Question" } as const;

export function SupportCase({ data: path = "case.json" }: { data?: string }) {
  const data = useData<CaseData>(path);
  const [status] = useShared<CaseStatus | null>("case/status", null);
  const viewer = useViewer();
  const now = useNow();
  if (!data) return null;
  const s = STATUS[status?.status ?? "new"] ?? STATUS.new;
  const context = Object.entries(data.context ?? {}).filter(([, v]) => v);
  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span>
            {KIND[data.kind] ?? "Request"} #{data.number}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            from {displayName(data.reporter)}
            {data.viaAgent ? " (via their agent)" : ""}, {relativeTime(data.submittedAt, now)}
          </span>
        </div>
        <h1 className="m-0 text-[1.75rem] leading-tight font-semibold text-balance">{data.title}</h1>
      </header>

      <section className="rounded-xl border border-border bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          {status?.at && <span className="text-[13px] text-muted-foreground">{relativeTime(status.at, now)}</span>}
        </div>
        <p className="mt-2 mb-0 text-[15px] leading-relaxed">{s.text}</p>
        {status?.fix?.summary && <p className="mt-2 mb-0 text-[15px] leading-relaxed text-muted-foreground">What changed: {status.fix.summary}</p>}
        {status?.thread && (
          <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => post({ t: "comment:open", thread: status.thread! })}>
            Open the conversation
          </Button>
        )}
      </section>

      {(status?.status === "fix_deployed" || status?.status === "resolved") && viewer.email === data.reporter && <Confirm reporter={data.reporter} />}

      {(context.length > 0 || data.error) && (
        <section>
          <h2 className="mb-2 text-[13px] font-medium tracking-wide text-muted-foreground uppercase">Shared with the report</h2>
          <dl className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,2fr)] gap-x-3 gap-y-1 text-[14px]">
            {context.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-muted-foreground">{{ workspace: "Workspace", page: "Page", browser: "Browser", version: "App version" }[k] ?? k}</dt>
                <dd className="m-0 min-w-0 break-words">{v}</dd>
              </React.Fragment>
            ))}
            {data.error && (
              <>
                <dt className="text-muted-foreground">Error</dt>
                <dd className="m-0 min-w-0 break-words">
                  {data.error.message} <span className="text-muted-foreground">({data.error.id})</span>
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      {status?.history && status.history.length > 1 && (
        <section>
          <h2 className="mb-2 text-[13px] font-medium tracking-wide text-muted-foreground uppercase">History</h2>
          <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[14px]">
            {status.history.map((h, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-28 shrink-0 text-muted-foreground">{new Date(h.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span>{(STATUS[h.status] ?? STATUS.new).label}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/** "Did this fix it?": the reporter's own answer, stored as their decision so the assistant hears of it. */
function Confirm({ reporter }: { reporter: string }) {
  const [answer, setAnswer] = useShared<{ decision?: string; at?: number } | null>(`approve/fixed/${reporter}`, null);
  const said = answer?.decision;
  return (
    <section className={cn("rounded-xl border p-4", said === "approve" ? "border-positive/40" : "border-border")}>
      <p className="m-0 font-medium">Did this fix it?</p>
      {said ? (
        <p className="mt-1 mb-0 text-[14px] text-muted-foreground">
          {said === "approve" ? "Thanks for confirming." : "Thanks; we'll keep at it. Add anything useful in the conversation."}{" "}
          <button type="button" className="cursor-pointer text-primary underline" onClick={() => setAnswer(null)}>
            Change
          </button>
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => setAnswer({ decision: "approve" })}>
            Yes, it's fixed
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setAnswer({ decision: "changes" })}>
            No, still a problem
          </Button>
        </div>
      )}
    </section>
  );
}
