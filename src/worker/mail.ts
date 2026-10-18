// Email we send: sign-in codes, workspace invitations and "shared with you".
// Plain, short messages with one link each.

type MailEnv = { EMAIL?: SendEmail; MAIL_FROM: string };

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

async function send(env: MailEnv, to: string, subject: string, lines: string[], link?: { href: string; label: string }) {
  if (!env.EMAIL) throw new Error("no EMAIL binding");
  if (!deliverable(to)) return;
  const text = [...lines, ...(link ? ["", `${link.label}: ${link.href}`] : [])].join("\n\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:32rem">${lines
    .map((l) => `<p>${escape(l)}</p>`)
    .join("")}${
    link
      ? `<p><a href="${escape(link.href)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#6d5efc;color:#fff;text-decoration:none;font-weight:600">${escape(link.label)}</a></p>`
      : ""
  }</div>`;
  await env.EMAIL.send({ from: { name: "Artifacts", email: env.MAIL_FROM }, to, subject, text, html });
}

export async function sendCode(env: MailEnv, to: string, code: string) {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  if (!env.EMAIL) throw new Error("no EMAIL binding");
  if (!deliverable(to)) return;
  await env.EMAIL.send({
    from: { name: "Artifacts", email: env.MAIL_FROM },
    to,
    subject: `${spaced} is your Artifacts code`,
    text: `Your Artifacts sign-in code is ${spaced}.\n\nIt works once, for 10 minutes. If you didn't try to sign in, ignore this email.\n`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#222"><p>Your Artifacts sign-in code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${spaced}</p><p style="color:#666">It works once, for 10 minutes. If you didn't try to sign in, ignore this email.</p></div>`,
  });
}

export function sendInvite(env: MailEnv, to: string, input: { workspace: string; url: string; by: string | null; role: string }) {
  const who = input.by ? `${input.by} added you` : "You've been added";
  return send(
    env,
    to,
    `You're in ${input.workspace} on Artifacts`,
    [
      `${who} to ${input.workspace} on Artifacts as ${input.role === "admin" ? "an admin" : "a member"}.`,
      "Sign in with this email address to see what's shared with the workspace, and connect your agent from the workspace settings.",
    ],
    { href: input.url, label: `Open ${input.workspace}` },
  );
}

export function sendShare(env: MailEnv, to: string, input: { title: string; workspace: string; link: string; by: string | null }) {
  return send(
    env,
    to,
    `${input.by ?? "Someone"} shared “${input.title}” with you`,
    [`${input.by ?? "Someone"} shared “${input.title}” with you on Artifacts (${input.workspace}).`],
    { href: input.link, label: "Open it" },
  );
}
