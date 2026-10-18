import { expect, test } from "bun:test";
import { sendCode, sendInvite, sendNotificationEmail, sendShare } from "../src/worker/mail.ts";

type Sent = { to: string; subject: string; text: string; html: string; headers?: Record<string, string> };

function capture(apex = "https://apex.test") {
  const sent: Sent[] = [];
  const env = { MAIL_FROM: "sign-in@mail.test", APEX_ORIGIN: apex, EMAIL: { send: async (m: Sent) => void sent.push(m) } as unknown as SendEmail };
  return { env, sent };
}

test("mail to reserved test domains is dropped; real addresses are sent", async () => {
  const sent: string[] = [];
  const env = { MAIL_FROM: "sign-in@mail.test", EMAIL: { send: async (m: { to: string }) => void sent.push(m.to) } as unknown as SendEmail };
  await sendCode(env, "e2e@example.com", "123456");
  await sendInvite(env, "x@corp.test", { workspace: "W", url: "https://w", by: null, role: "member" });
  await sendShare(env, "y@q.invalid", { title: "T", workspace: "W", link: "https://w", by: "a@b.co" });
  expect(sent).toEqual([]);
  await sendShare(env, "dana@corp.com", { title: "T", workspace: "W", link: "https://w", by: "a@b.co" });
  expect(sent).toEqual(["dana@corp.com"]);
});

test("the sign-in code is eight contiguous digits everywhere, shielded from data detectors", async () => {
  const { env, sent } = capture();
  await sendCode(env, "dana@corp.com", "12345678");
  const [m] = sent;
  expect(m!.subject).toBe("12345678 is your artifacts.boo code");
  for (const part of [m!.subject, m!.text, m!.html]) {
    expect(part).toContain("12345678");
    expect(part).not.toMatch(/\d{4}[\s -]\d{4}/);
  }
  expect(m!.html).toContain('<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">');
  expect(m!.html).toContain("a[x-apple-data-detectors]");
  expect(m!.text).toContain("It works once, for 10 minutes.");
});

test("every email is a full branded document using the apex logo", async () => {
  const { env, sent } = capture("https://apex.test");
  await sendCode(env, "a@corp.com", "12345678");
  await sendInvite(env, "a@corp.com", { workspace: "W", url: "https://w", by: "b@corp.com", role: "admin" });
  await sendShare(env, "a@corp.com", { title: "T", workspace: "W", link: "https://w", by: null });
  await sendNotificationEmail({ EMAIL: env.EMAIL, MAIL_FROM: env.MAIL_FROM }, "a@corp.com", { title: "T", body: "New comment", url: "https://w" }, "https://apex.test");
  expect(sent).toHaveLength(4);
  for (const m of sent) {
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
    expect(m.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(m.html).toContain('src="https://apex.test/static/icons/icon-192.png"');
    expect(m.html).toContain("prefers-color-scheme: dark");
    expect(m.text.length).toBeGreaterThan(0);
  }
});

test("user-supplied strings are escaped", async () => {
  const { env, sent } = capture();
  const evil = `<script>alert("x")</script>`;
  await sendShare(env, "a@corp.com", { title: evil, workspace: evil, link: `https://w/"><b>`, by: evil });
  await sendInvite(env, "a@corp.com", { workspace: evil, url: "https://w", by: evil, role: "member" });
  await sendNotificationEmail(env, "a@corp.com", { title: evil, body: evil, url: "https://w" }, "https://apex.test");
  for (const m of sent) {
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain('"><b>');
    expect(m.html).toContain("&lt;script&gt;");
  }
});

test("notifications carry List-Unsubscribe and the off switch", async () => {
  const { env, sent } = capture();
  await sendNotificationEmail({ EMAIL: env.EMAIL, MAIL_FROM: env.MAIL_FROM }, "a@corp.com", { title: "Plan", body: "Ana replied", url: "https://w/a" }, "https://apex.test");
  const [m] = sent;
  expect(m!.headers?.["List-Unsubscribe"]).toBe("<https://apex.test/me>");
  expect(m!.html).toContain("Turn email notifications off");
  expect(m!.html).toContain('href="https://apex.test/me"');
  expect(m!.text).toContain("Turn email notifications off: https://apex.test/me");
});
