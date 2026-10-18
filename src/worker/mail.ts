// Email we send: sign-in codes, workspace invitations, "shared with you" and notifications.
// Every message shares one branded layout (table-based, inline styles) and has a plain-text twin.
import { PRODUCT } from "../shared/brand.ts";

type MailEnv = { EMAIL?: SendEmail; MAIL_FROM: string; APEX_ORIGIN?: string };

const DEFAULT_APEX = "https://artifacts.boo";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const C = { page: "#f4f3fb", card: "#ffffff", text: "#1d1b2e", muted: "#6b6880", accent: "#6d5efc", tint: "#efedff", line: "#e6e4f2" };

/** Addresses no real person can hold (RFC 2606 / 6761), used by end-to-end checks. */
export function isTestAddress(email: string): boolean {
  return /^[^\s@]+@([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.(test|invalid|example))$/.test(email);
}

/** Mail to test addresses is dropped: it could only bounce, and bounces cost the sender its reputation. */
function deliverable(to: string): boolean {
  return !isTestAddress(to.toLowerCase());
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function apexOf(env: MailEnv): string {
  return (env.APEX_ORIGIN || DEFAULT_APEX).replace(/\/+$/, "");
}

/** A paragraph of body copy; `html` is already escaped. */
function para(html: string, style = "", cls = "text"): string {
  return `<p class="${cls}" style="margin:0 0 16px;font-size:15px;line-height:24px;color:${C.text};${style}">${html}</p>`;
}

/** A bulletproof button: the table cell carries the colour so it survives clients that drop link padding. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px"><tr><td class="btn" bgcolor="${C.accent}" style="border-radius:10px;background:${C.accent}"><a href="${escape(href)}" target="_blank" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${escape(label)}</a></td></tr></table>`;
}

/** The shared document: hidden preheader, logo header, white card, muted footer. `body` and `footer` are HTML. */
function layout(input: { apex: string; title: string; preheader: string; body: string; footer: string }): string {
  const apex = escape(input.apex);
  const css = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font:inherit!important}
u + #body a{color:inherit;text-decoration:none;font-size:inherit;font-weight:inherit;line-height:inherit}
@media (prefers-color-scheme: dark){
.page{background:#0b0d15!important}
.card{background:#161827!important;border-color:#262940!important}
.text,.word{color:#ecebf5!important}
.muted,.muted a{color:#9c99b3!important}
.codebox{background:#221f45!important;border-color:#37326b!important}
.code{color:#ecebf5!important}
.accent{color:#9d93ff!important}
}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="x-apple-disable-message-reformatting">
<title>${escape(input.title)}</title>
<style>${css}</style>
</head>
<body id="body" class="page" style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escape(input.preheader)}${"&#8199;&#847; ".repeat(30)}</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;font-family:${FONT}">
<tr><td style="padding:0 8px 20px">
<a href="${apex}" target="_blank" style="text-decoration:none"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;padding-right:10px"><img src="${apex}/static/icons/icon-192.png" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border:0;border-radius:8px"></td>
<td class="word" style="vertical-align:middle;font-family:${FONT};font-size:19px;line-height:24px;font-weight:700;letter-spacing:-0.2px;color:${C.text}">artifacts<span class="accent" style="color:${C.accent}">.boo</span></td>
</tr></table></a>
</td></tr>
<tr><td class="card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:32px 32px 24px">
${input.body}
</td></tr>
<tr><td class="muted" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted}">
${input.footer}<br><a href="${apex}" target="_blank" style="color:${C.muted};text-decoration:underline">${escape(PRODUCT)}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

type Message = { subject: string; text: string; html: string; headers?: Record<string, string> };

async function deliver(env: MailEnv, to: string, m: Message) {
  if (!env.EMAIL) throw new Error("no EMAIL binding");
  if (!deliverable(to)) return;
  await env.EMAIL.send({ from: { name: PRODUCT, email: env.MAIL_FROM }, to, ...m });
}

/** A short message: paragraphs and one button, with the footer saying why it was sent. */
function simple(env: MailEnv, to: string, input: { subject: string; preheader: string; lines: string[]; link: { href: string; label: string }; footer: string }) {
  const text = [...input.lines, `${input.link.label}: ${input.link.href}`, `--\n${input.footer}\n${PRODUCT}`].join("\n\n") + "\n";
  const body = input.lines.map((l) => para(escape(l))).join("\n") + button(input.link.href, input.link.label);
  const html = layout({ apex: apexOf(env), title: input.subject, preheader: input.preheader, body, footer: escape(input.footer) });
  return deliver(env, to, { subject: input.subject, text, html });
}

/** The sign-in code, as eight contiguous digits: a space makes iOS read it as a phone number and skip autofill. */
export async function sendCode(env: MailEnv, to: string, code: string) {
  const digits = code.replace(/\s+/g, "");
  const subject = `${digits} is your ${PRODUCT} code`;
  const lead = `Enter this code to sign in to ${PRODUCT}. It works once, for 10 minutes.`;
  const ignore = "If you didn't try to sign in, you can ignore this email.";
  const footer = `You got this because someone asked to sign in to ${PRODUCT} with this address.`;
  const text = `Your ${PRODUCT} sign-in code is ${digits}\n\n${lead}\n\n${ignore}\n\n--\n${footer}\n${PRODUCT}\n`;
  const box = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr><td class="codebox" align="center" bgcolor="${C.tint}" style="background:${C.tint};border:1px solid #dcd8ff;border-radius:12px;padding:18px 12px"><span class="code" style="font-family:${MONO};font-size:32px;line-height:40px;font-weight:600;letter-spacing:6px;padding-left:6px;font-variant-numeric:tabular-nums;color:${C.text};text-decoration:none;white-space:nowrap">${escape(digits)}</span></td></tr></table>`;
  const body = [
    `<h1 class="text" style="margin:0 0 12px;font-size:20px;line-height:28px;font-weight:700;color:${C.text}">Your sign-in code</h1>`,
    para(escape(lead)),
    box,
    para(escape(ignore), `color:${C.muted};font-size:14px;line-height:22px`, "muted"),
  ].join("\n");
  const html = layout({ apex: apexOf(env), title: subject, preheader: `${digits} is your sign-in code. It works once, for 10 minutes.`, body, footer: escape(footer) });
  await deliver(env, to, { subject, text, html });
}

/** A notification (comments, replies, updates), with a way to turn these emails off. */
export async function sendNotificationEmail(env: MailEnv, to: string, msg: { title: string; body: string; url: string }, apex: string) {
  const base = (apex || env.APEX_ORIGIN || DEFAULT_APEX).replace(/\/+$/, "");
  const settings = `${base}/me`;
  const subject = `${msg.title}: ${msg.body.length > 80 ? `${msg.body.slice(0, 77)}…` : msg.body}`;
  const reason = `You get these because you take part in “${msg.title}”.`;
  const text = `${msg.title}\n\n${msg.body}\n\nOpen it: ${msg.url}\n\n--\n${reason}\nTurn email notifications off: ${settings}\n`;
  const body = [
    `<p class="muted" style="margin:0 0 8px;font-size:13px;line-height:18px;font-weight:600;color:${C.muted}">${escape(msg.title)}</p>`,
    para(escape(msg.body), "white-space:pre-line"),
    button(msg.url, "Open it"),
  ].join("\n");
  const footer = `${escape(reason)} <a href="${escape(settings)}" target="_blank" style="color:${C.muted};text-decoration:underline">Turn email notifications off</a>.`;
  const html = layout({ apex: base, title: subject, preheader: msg.body, body, footer });
  await deliver(env, to, { subject, text, html, headers: { "List-Unsubscribe": `<${settings}>` } });
}

export function sendInvite(env: MailEnv, to: string, input: { workspace: string; url: string; by: string | null; role: string }) {
  const who = input.by ? `${input.by} added you` : "You've been added";
  const intro = `${who} to ${input.workspace} on ${PRODUCT} as ${input.role === "admin" ? "an admin" : "a member"}.`;
  return simple(env, to, {
    subject: `You're in ${input.workspace} on ${PRODUCT}`,
    preheader: intro,
    lines: [intro, "Sign in with this email address to see what's shared with the workspace, and connect your agent from the workspace settings."],
    link: { href: input.url, label: `Open ${input.workspace}` },
    footer: `You got this because you were added to ${input.workspace}.`,
  });
}

export function sendShare(env: MailEnv, to: string, input: { title: string; workspace: string; link: string; by: string | null }) {
  const who = input.by ?? "Someone";
  const line = `${who} shared “${input.title}” with you on ${PRODUCT} (${input.workspace}).`;
  return simple(env, to, {
    subject: `${who} shared “${input.title}” with you`,
    preheader: line,
    lines: [line],
    link: { href: input.link, label: "Open it" },
    footer: `You got this because ${who} shared an artifact with this address.`,
  });
}
