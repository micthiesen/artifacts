import { expect, test } from "bun:test";
import { sendCode, sendInvite, sendShare } from "../src/worker/mail.ts";

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
