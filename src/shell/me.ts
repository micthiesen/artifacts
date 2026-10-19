// /me. On the apex ("Account"): your display name and notification channels,
// which follow you into every workspace, and links to each workspace's own
// settings. In a workspace ("Notifications in <name>"): how much you hear about
// each artifact there. Everything goes through that host's /api/me. A failed
// action only shows its notice, so what you typed stays put.
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { PRODUCT } from "../shared/brand.ts";
import type { WatchLevel } from "../shared/protocol.ts";

type Channel = { id: string; type: string; label: string; createdAt: string; lastError: string | null; disabled: boolean };
type Profile = {
  email: string;
  // Apex (account) only.
  name?: string | null;
  emailNotifications?: boolean;
  channels?: Channel[];
  workspaces?: { slug: string; name: string; role: "admin" | "member" | "guest"; url: string; suspended: boolean }[];
  passkeys?: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  vapidPublicKey?: string | null;
  pushover?: boolean;
  // Workspace only.
  workspace?: { name: string };
  watches?: { id: string; title: string; level: WatchLevel; custom: boolean }[];
  /** How many active artifacts you can see here; the list shows those set apart plus the most recent. */
  watchesTotal?: number;
  /** Your default for this workspace; null is the standard one. */
  watchDefault?: WatchLevel | null;
  account?: string;
  /** Your role here, if you're a member (not just a guest). */
  member?: "admin" | "member" | null;
};

const main = document.getElementById("profile")!;
const LEVELS: [WatchLevel, string][] = [
  ["all", "All activity"],
  ["participating", "Replies and mentions"],
  ["mute", "Nothing"],
];

/** Thrown on 401: the session cookie expired or was revoked. */
class SessionEnded extends Error {}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) throw new SessionEnded("Your session ended.");
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; reauth?: boolean };
  // Some changes need a recent sign-in: say so, with a way to sign in again.
  if (data.reauth) throw new SessionEnded(data.error ?? "Sign in again to do that.");
  if (!res.ok) throw new Error(data.error ?? "That didn't work. Try again in a moment.");
  return data;
}

let profile: Profile;
type Notice = { tone: "ok" | "error"; text: string; signIn?: boolean; reveal?: { label: string; value: string; hint: string } };
let notice: Notice | null = null;

async function load() {
  profile = await api<Profile>("/api/me");
  render();
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

function btn(label: string, onClick: () => void | Promise<void>, cls = "button small") {
  const b = h("button", { type: "button", class: cls }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

const failed = (err: unknown): Notice =>
  err instanceof SessionEnded ? { tone: "error", text: err.message, signIn: true } : { tone: "error", text: (err as Error).message };

function noticeNode(n: Notice) {
  const el = h("div", { class: `notice ${n.tone}`, role: "status" }, n.text);
  if (n.signIn) el.append(" ", h("a", { href: `/login?fresh=1&return=${encodeURIComponent(location.pathname + location.search)}` }, "Sign in again"));
  if (n.reveal) {
    const reveal = n.reveal;
    const copy = btn("Copy", async () => {
      await navigator.clipboard.writeText(reveal.value);
      copy.textContent = "Copied ✓";
    });
    el.append(h("div", { class: "reveal-row" }, h("strong", {}, reveal.label), h("code", { class: "reveal" }, reveal.value), copy), h("p", { class: "muted small" }, reveal.hint));
  }
  return el;
}

/** Shows a notice at the top without re-rendering. */
function flash(n: Notice) {
  const el = noticeNode(n);
  const existing = main.querySelector(":scope > .notice");
  const title = main.querySelector(":scope > .page-title");
  if (existing) existing.replaceWith(el);
  else if (title) title.after(el);
  else main.prepend(el);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
  } catch (err) {
    notice = null;
    flash(failed(err));
    return;
  }
  if (ok) notice = { tone: "ok", text: ok };
  try {
    await load();
  } catch (err) {
    flash(failed(err));
  }
}

const title = () => (profile.watches ? (profile.workspace ? `Notifications in ${profile.workspace.name}` : "Notifications") : "Account");

function render() {
  // Keep the server's " · <brand>" suffix.
  document.title = [title(), ...document.title.split(" · ").slice(1)].join(" · ");
  const sections: HTMLElement[] = [h("h1", { class: "page-title" }, title())];
  if (notice) sections.push(noticeNode(notice));

  if (profile.watches) renderWatches(sections, profile.watches);
  else renderAccount(sections);
  main.replaceChildren(...sections);
  // Notices render at the top; bring them into view after an action lower down.
  if (notice) main.querySelector(".notice")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  notice = null;
}

function renderAccount(sections: HTMLElement[]) {
  // Name
  const name = h("input", { type: "text", value: profile.name ?? "", placeholder: profile.email.split("@")[0], maxlength: "80", "aria-label": "Display name" }) as HTMLInputElement;
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "You"),
      h("p", { class: "muted" }, `Signed in as ${profile.email}. Your name appears on your comments and in notifications.`),
      h("div", { class: "row" }, name, btn("Save", () => act(() => api("/api/me", { body: { name: name.value } }), "Name saved."))),
    ),
  );

  sections.push(passkeySection(profile.passkeys ?? []));

  // Channels: email first (on by default), then whatever you added.
  const list = h("ul", { class: "channels" });
  const emailOn = profile.emailNotifications !== false;
  list.append(
    h(
      "li",
      {},
      h("span", { class: "channel-label" }, "Email"),
      h("span", { class: "muted small" }, profile.email),
      h("span", { class: `chip${emailOn ? " positive" : ""}` }, emailOn ? "On" : "Off"),
      h(
        "span",
        { class: "channel-actions" },
        btn(emailOn ? "Turn off" : "Turn on", () => act(() => api("/api/me", { body: { emailNotifications: !emailOn } }), emailOn ? "Email notifications are off." : "Email notifications are on."), "button small ghost"),
      ),
    ),
  );
  for (const c of profile.channels ?? []) {
    const status = c.disabled ? h("span", { class: "chip caution" }, "Paused after errors") : c.lastError ? h("span", { class: "chip caution" }, "Last send failed") : h("span", { class: "chip positive" }, "On");
    const li = h("li", {}, h("span", { class: "channel-label" }, c.label), status);
    if (c.lastError) li.append(h("span", { class: "muted small channel-error" }, c.lastError));
    li.append(
      h(
        "span",
        { class: "channel-actions" },
        btn("Send test", () => act(() => api(`/api/me/channels/${c.id}/test`, { body: {} }), `Test sent to ${c.label}.`), "button small ghost"),
        btn("Remove", () => act(() => api(`/api/me/channels/${c.id}`, { method: "DELETE" }), `Removed ${c.label}.`), "button small ghost danger"),
      ),
    );
    list.append(li);
  }

  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Where to notify you"),
      h(
        "p",
        { class: "muted" },
        "Every channel that's on gets every notification, from every workspace: comments on artifacts you own, replies to your comments and @mentions. Nothing is sent while you have the artifact open.",
      ),
      list,
      addChannels(),
    ),
  );

  // Workspaces, including ones where you're only a guest on shared artifacts.
  const workspaces = profile.workspaces ?? [];
  const roleChip = (role: "admin" | "member" | "guest") => h("span", { class: `chip${role === "admin" ? " positive" : ""}` }, role);
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Your workspaces"),
      h(
        "p",
        { class: "muted" },
        "Each workspace has its own Notifications page: set a default for the whole workspace (say, nothing from one you belong to on a second address), or a level per artifact.",
      ),
      workspaces.length
        ? h(
            "ul",
            { class: "channels" },
            ...workspaces.map((w) => {
              const li = h("li", {}, h("a", { class: "channel-label", href: `${w.url}/` }, w.name), roleChip(w.role));
              if (w.suspended) li.append(h("span", { class: "chip caution" }, "suspended"));
              else li.append(h("span", { class: "channel-actions" }, h("a", { class: "button small ghost", href: `${w.url}/me` }, "Notifications")));
              return li;
            }),
          )
        : h("p", { class: "muted" }, "None yet. When someone shares an artifact with you, its workspace shows up here."),
    ),
  );
  sections.push(signOutEverywhereSection());
  sections.push(deleteAccountSection());
}

/** Ends every session this person has: every browser and device, every workspace, this one included. */
function signOutEverywhereSection(): HTMLElement {
  return h(
    "section",
    { class: "card-section" },
    h("h2", {}, "Sign out everywhere"),
    h("p", { class: "muted" }, "Signs you out on every browser and device, in every workspace, this one included. Use it if you signed in somewhere you shouldn't have stayed signed in."),
    h(
      "div",
      { class: "row" },
      btn(
        "Sign out everywhere",
        () =>
          showing(async () => {
            const r = await api<{ location: string }>("/api/me/sign-out-everywhere", { body: {} });
            location.href = r.location;
            await new Promise(() => {});
          }),
        "button small secondary",
      ),
    ),
  );
}

function passkeySection(passkeys: NonNullable<Profile["passkeys"]>): HTMLElement {
  const day = (iso: string) => new Date(iso).toLocaleDateString();
  const list = h(
    "ul",
    { class: "channels" },
    ...passkeys.map((p) =>
      h(
        "li",
        {},
        h("span", { class: "channel-label" }, p.name),
        h("span", { class: "muted small" }, `Added ${day(p.createdAt)}${p.lastUsedAt ? ` · last used ${day(p.lastUsedAt)}` : " · not used yet"}`),
        h(
          "span",
          { class: "channel-actions" },
          btn("Remove", () => act(() => api(`/api/me/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }), `Removed ${p.name}. Remove it from your device or password manager too.`), "button small ghost danger"),
        ),
      ),
    ),
  );
  const section = h(
    "section",
    { class: "card-section" },
    h("h2", {}, "Passkeys"),
    h("p", { class: "muted" }, "Sign in with Face ID, Touch ID, your device's screen lock or a security key instead of an emailed code. Codes keep working too."),
  );
  if (passkeys.length) section.append(list);
  if (browserSupportsWebAuthn()) section.append(btn("Add a passkey", () => act(addPasskey, "Passkey saved. Next time, pick it when you sign in.")));
  else if (!passkeys.length) section.append(h("p", { class: "muted small" }, "This browser can't save passkeys."));
  return section;
}

async function addPasskey() {
  const { options, token } = await api<{ options: never; token: string }>("/api/me/passkeys/options", { body: {} });
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "InvalidStateError") throw new Error("This device or password manager already has one of your passkeys.");
    if (name === "NotAllowedError" || name === "AbortError") throw new Error("No passkey was saved.");
    throw err;
  }
  await api("/api/me/passkeys", { body: { token, response } });
}

function renderWatches(sections: HTMLElement[], watches: NonNullable<Profile["watches"]>) {
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Name and channels"),
      h("p", { class: "muted" }, "Where notifications go (this browser, Pushover, ntfy, webhooks) and your display name are set once for every workspace."),
      h("a", { class: "button small", href: profile.account ?? "/" }, "Open your account"),
    ),
  );
  // The workspace-wide default, which every artifact follows unless you chose otherwise for it.
  const fallback = profile.watchDefault ?? null;
  const defaultSelect = h("select", { "aria-label": "Default for this workspace" }) as HTMLSelectElement;
  for (const [value, label] of [["standard", "Standard"], ...LEVELS] as [string, string][]) {
    const o = h("option", { value }, label) as HTMLOptionElement;
    o.selected = value === (fallback ?? "standard");
    defaultSelect.append(o);
  }
  defaultSelect.addEventListener("change", () =>
    act(
      () => api("/api/me/watch-default", { body: { level: defaultSelect.value === "standard" ? null : defaultSelect.value } }),
      defaultSelect.value === "mute" ? "You won't get notifications from this workspace." : "Default saved.",
    ),
  );
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Default for this workspace"),
      h(
        "p",
        { class: "muted" },
        "Applies to every artifact here, now and later, unless you pick something else for one below. Standard is all activity on artifacts you own and replies and mentions elsewhere. Choose “Nothing” to stay a member without notifications here, say on a second address.",
      ),
      defaultSelect,
    ),
  );
  const followLabel = fallback ? `Workspace default (${LEVELS.find(([l]) => l === fallback)![1].toLowerCase()})` : "Workspace default";
  const rows = watches.map((w) => {
    const select = h("select", { "aria-label": `Notifications for ${w.title}` }) as HTMLSelectElement;
    const follow = h("option", { value: "" }, followLabel) as HTMLOptionElement;
    follow.selected = !w.custom;
    select.append(follow);
    for (const [level, label] of LEVELS) {
      const o = h("option", { value: level }, label) as HTMLOptionElement;
      o.selected = w.custom && level === w.level;
      select.append(o);
    }
    select.addEventListener("change", () => act(() => api("/api/me/watch", { body: { id: w.id, level: select.value || null } })));
    return h("tr", {}, h("td", {}, h("a", { href: `/a/${w.id}` }, w.title)), h("td", {}, select));
  });
  sections.push(
    h(
      "section",
      { class: "card-section" },
      h("h2", {}, "Artifacts"),
      h("p", { class: "muted" }, "“All activity” also includes page updates. Pick a level for one artifact to set it apart from the workspace default."),
      rows.length ? h("table", { class: "watches" }, h("tbody", {}, ...rows)) : h("p", { class: "muted" }, "Nothing is shared with you here yet."),
      ...((profile.watchesTotal ?? 0) > watches.length
        ? [h("p", { class: "muted small" }, `Showing the ${watches.length} most recent of ${profile.watchesTotal}. For any other, use the avatar menu on the artifact itself.`)]
        : []),
    ),
  );
  if (profile.member) sections.push(leaveSection());
}

/** A member takes themselves out of this workspace; artifacts they own pass to an admin. */
function leaveSection(): HTMLElement {
  const name = profile.workspace?.name ?? "this workspace";
  let armed = false;
  const b = btn(
    "Leave workspace",
    () => {
      if (!armed) {
        armed = true;
        b.textContent = `Yes, leave ${name}`;
        note.textContent = "Press again to leave. Your agents lose access here, and artifacts you own pass to an admin.";
        return;
      }
      // The refusal (say, the last admin) shows here, next to the button, not in a banner far above.
      return showing(async () => {
        try {
          const r = await api<{ location: string }>("/api/me/leave", { body: {} });
          location.href = r.location;
          await new Promise(() => {});
        } catch (err) {
          note.textContent = (err as Error).message;
          note.classList.add("notice", "error");
          armed = false;
          b.textContent = "Leave workspace";
        }
      });
    },
    "button small secondary",
  );
  const note = h("p", { class: "muted" }, `You'd stop being a member of ${name}. Artifacts shared with you directly still open.`);
  return h("section", { class: "card-section" }, h("h2", {}, "Leave"), note, h("div", { class: "row" }, b));
}

async function showing(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    flash(failed(err));
  }
}

/** Delete your account: first see what that means (and what's in the way), then type delete. */
function deleteAccountSection(): HTMLElement {
  const body = h("div", {});
  const section = h(
    "section",
    { class: "card-section" },
    h("h2", {}, "Delete your account"),
    h("p", { class: "muted" }, "Removes you from every workspace, stops everything shared with your address being shared with you, and deletes your name, channels and passkeys. Comments you wrote stay where they are, under your address; ask an admin there to remove them."),
    body,
  );
  // Only the final delete goes through act(): it reloads and re-renders, which would drop these steps.
  const check = btn(
    "Delete account…",
    () =>
      showing(async () => {
        const plan = await api<{ blockers: string[]; deletes: { name: string }[]; leaves: { name: string }[]; guestOf: { name: string }[] }>("/api/me/delete");
        body.replaceChildren();
        if (plan.blockers.length) {
          body.append(h("p", {}, "First:"), h("ul", {}, ...plan.blockers.map((b) => h("li", {}, b))));
          return;
        }
        if (plan.deletes.length) body.append(h("p", {}, `These workspaces have no other members, so they're deleted too, and anyone you shared their artifacts with loses access: ${plan.deletes.map((w) => w.name).join(", ")}. Download anything you need from their settings first.`));
        if (plan.leaves.length) body.append(h("p", { class: "muted" }, `You leave: ${plan.leaves.map((w) => w.name).join(", ")}.`));
        if (plan.guestOf.length) body.append(h("p", { class: "muted" }, `Artifacts shared with you in ${plan.guestOf.map((w) => w.name).join(", ")} stop being shared with you.`));
        const confirm = h("input", { class: "input", type: "text", autocomplete: "off", "aria-label": "Type delete to confirm", placeholder: "delete" }) as HTMLInputElement;
        body.append(
          h("p", { class: "muted" }, "It can't be undone. Type delete to confirm."),
          h(
            "div",
            { class: "row" },
            confirm,
            btn(
              "Delete my account",
              () =>
                act(async () => {
                  const r = await api<{ location: string }>("/api/me/delete", { body: { confirm: confirm.value.trim() } });
                  location.href = r.location;
                  await new Promise(() => {});
                }),
              "button small danger-solid",
            ),
          ),
        );
      }),
    "button small secondary",
  );
  body.append(h("div", { class: "row" }, check));
  return section;
}

function addChannels(): HTMLElement {
  const wrap = h("div", { class: "add-channels" });

  // This browser (Web Push)
  const pushCard = h("div", { class: "add-card" }, h("h3", {}, "This browser or phone"));
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!profile.vapidPublicKey) {
    pushCard.append(h("p", { class: "muted small" }, "Browser notifications aren't set up on this server."));
  } else if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    pushCard.append(
      h(
        "p",
        { class: "muted small" },
        ios && !standalone
          ? `On iPhone and iPad: tap Share, then “Add to Home Screen”, open ${PRODUCT} from your Home Screen and come back here.`
          : "This browser doesn't support push notifications.",
      ),
    );
  } else {
    pushCard.append(
      h("p", { class: "muted small" }, "Notifications appear like any app's. Add each device you want notified."),
      btn("Turn on for this device", () => act(enablePush, "This device will get notifications.")),
    );
  }
  wrap.append(pushCard);

  // Pushover
  const user = h("input", { type: "text", placeholder: "Your Pushover user key", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const token = h("input", { type: "text", placeholder: profile.pushover ? "App token (optional)" : "Your Pushover app token", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const pushover = h(
    "div",
    { class: "add-card" },
    h("h3", {}, "Pushover"),
    h("p", { class: "muted small" }, "Paste the user key from the top of pushover.net after you sign in."),
    user,
  );
  if (!profile.pushover) pushover.append(token);
  pushover.append(
    btn("Add Pushover", () =>
      act(() => api("/api/me/channels", { body: { type: "pushover", user: user.value, ...(token.value ? { token: token.value } : {}) } }), "Pushover added. Send a test to check it."),
    ),
  );
  wrap.append(pushover);

  // ntfy
  const ntfyToken = h("input", { type: "text", placeholder: "ntfy access token (tk_…)", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const ntfyServer = h("input", { type: "url", placeholder: "Server (default https://ntfy.sh)", autocomplete: "off" }) as HTMLInputElement;
  wrap.append(
    h(
      "div",
      { class: "add-card" },
      h("h3", {}, "ntfy"),
      h(
        "p",
        { class: "muted small" },
        "Install the ntfy app, then subscribe to the private topic we create. ntfy.sh limits messages from shared cloud servers like this one, so add a free ntfy.sh account's access token (Account → Access tokens), or use your own ntfy server.",
      ),
      ntfyToken,
      ntfyServer,
      btn("Create a private topic", () =>
        act(async () => {
          const r = await api<{ label: string; reveal: string }>("/api/me/channels", {
            body: { type: "ntfy", ...(ntfyToken.value ? { token: ntfyToken.value } : {}), ...(ntfyServer.value ? { server: ntfyServer.value } : {}) },
          });
          notice = {
            tone: "ok",
            text: "ntfy topic created. Send a test once you've subscribed.",
            reveal: { label: "Subscribe to", value: r.reveal, hint: "In the ntfy app tap +, paste this, and keep it private: anyone with it can read your notifications." },
          };
        }),
      ),
    ),
  );

  // Webhook
  const url = h("input", { type: "url", placeholder: "https://… (Discord works too)", autocomplete: "off" }) as HTMLInputElement;
  wrap.append(
    h(
      "div",
      { class: "add-card" },
      h("h3", {}, "Webhook"),
      h("p", { class: "muted small" }, "We POST JSON {title, body, url, artifact, events} signed with X-Artifacts-Signature. events lists each comment, decision, form response and update, so an automation can wake your agent to act on it."),
      url,
      btn("Add webhook", () =>
        act(async () => {
          const r = await api<{ reveal: string }>("/api/me/channels", { body: { type: "webhook", url: url.value } });
          notice = {
            tone: "ok",
            text: "Webhook added.",
            reveal: { label: "Signing secret", value: r.reveal, hint: "HMAC-SHA256 of the raw body with this secret, hex, sent as sha256=<hex>. It isn't shown again." },
          };
        }),
      ),
    ),
  );
  return wrap;
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser settings and try again.");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(profile.vapidPublicKey!) }));
  await api("/api/me/channels", { body: { type: "webpush", ...sub.toJSON() } });
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

load().catch((err) => {
  main.replaceChildren(h("h1", { class: "page-title" }, main.dataset.context === "workspace" ? "Notifications" : "Account"), noticeNode(failed(err)));
});
