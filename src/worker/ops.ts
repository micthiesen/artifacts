// What the operator needs to know about, without watching logs: every event is
// one JSON log line (searchable in Workers Logs by kind and slug), a row in the
// directory's ops log (the operator console lists the latest), and, for urgent
// kinds, an email to the operator, at most once an hour per alert key.
import type { DirectoryApi } from "./directory.ts";
import { sendOperatorNote } from "./mail.ts";

export type OpsEnv = {
  DIRECTORY: DurableObjectNamespace;
  EMAIL?: SendEmail;
  MAIL_FROM?: string;
  APEX_ORIGIN?: string;
  OPERATOR_EMAILS?: string;
};

export type OpsEvent = {
  /** Short and stable, for searching: "billing_webhook_failed", "backup_failed", "report"… */
  kind: string;
  slug?: string | null;
  message: string;
  /** Ids worth having later: artifact, event, subscription. Never secrets or message bodies. */
  detail?: Record<string, unknown>;
  /** Email the operator, once an hour per this key (defaults to the kind and slug). Repeats within the hour are counted, not stored. */
  alert?: boolean | string;
  /** Store every occurrence even when its alert is quiet (reports: each one matters). */
  keepAll?: boolean;
};

/** Neither the directory nor the mail sender may hold up the request that reported the event. */
const OPS_TIMEOUT_MS = 3000;
const within = <T>(p: Promise<T>, fallback: T) => Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), OPS_TIMEOUT_MS))]);

/** Free text people typed stays out of the logs (it's in the ops log and the email). */
const UNLOGGED = new Set(["details", "from"]);

/** Records an event; never throws, so reporting a failure can't cause another. Returns whether it was stored. */
export async function ops(env: OpsEnv, e: OpsEvent): Promise<boolean> {
  const logged = Object.fromEntries(Object.entries(e.detail ?? {}).filter(([k]) => !UNLOGGED.has(k)));
  console.error(JSON.stringify({ ops: e.kind, slug: e.slug ?? undefined, message: e.message, ...logged }));
  let stored = false;
  let alert = false;
  try {
    const dir = env.DIRECTORY.getByName("directory") as unknown as DirectoryApi;
    const key = e.alert ? (typeof e.alert === "string" ? e.alert : `${e.kind}:${e.slug ?? ""}`) : null;
    const r = await within(
      dir.recordOps({ kind: e.kind, slug: e.slug ?? null, message: e.message, detail: e.detail ?? null, alertKey: key, keepAll: e.keepAll ?? false }),
      null,
    );
    stored = r !== null;
    alert = r?.alert ?? false;
  } catch (err) {
    console.error("recording an ops event failed", e.kind, err);
    alert = Boolean(e.alert);
  }
  if (alert && env.MAIL_FROM) {
    const apex = (env.APEX_ORIGIN ?? "").replace(/\/+$/, "");
    const lines = [e.message, ...Object.entries(e.detail ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)];
    const subject = e.message.length > 90 ? `${e.message.slice(0, 87)}…` : e.message;
    await within(sendOperatorNote(env as never, subject, lines, { href: `${apex}/admin`, label: "Operator console" }), undefined);
  }
  return stored;
}
