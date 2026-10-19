// Passkeys on the apex sign-in pages. On the email step, saved passkeys show up
// in the email field's autofill (or behind a button where a browser has no
// autofill for them); the server answers where to go, as after a code. After a
// code sign-in, the offer page saves a new passkey, or moves straight on when
// this browser can't make one.
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";

/** Mirrors PASSKEY_LATER_COOKIE in the Worker. */
const LATER_COOKIE = "art_passkey_later";
const LATER_DAYS = 30;

/** Said when the server gives no reason, instead of a bare status code. */
const SIGN_IN_FAILED = "That didn't work. Try again, or use the email code.";
const SAVE_FAILED = "That didn't work. Try again, or skip it for now.";

async function post<T>(path: string, body: unknown, failed: string): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? failed);
  return data;
}

/** The user dismissed the prompt or it timed out: not worth a message. */
function cancelled(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

function showError(text: string) {
  let el = document.getElementById("passkey-error");
  if (!el) {
    el = document.createElement("p");
    el.id = "passkey-error";
    el.className = "notice error";
    el.setAttribute("role", "alert");
    document.querySelector("#login form")?.before(el);
  }
  el.textContent = text;
  el.hidden = false;
}

async function signIn(section: HTMLElement, autofill: boolean) {
  const { options, token } = await post<{ options: never; token: string }>("/login/passkey/options", {}, SIGN_IN_FAILED);
  const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
  const { location: next } = await post<{ location: string }>("/login/passkey", {
    token,
    response,
    to: section.dataset.to ?? "",
    n: section.dataset.n ?? "",
    return: section.dataset.return ?? "",
  }, SIGN_IN_FAILED);
  location.assign(next);
}

async function loginPage(section: HTMLElement) {
  if (!browserSupportsWebAuthn()) return;
  const fail = (err: unknown) => {
    if (!cancelled(err)) showError((err as Error).message);
  };
  if (await browserSupportsWebAuthnAutofill()) {
    // Waits in the background until someone picks a passkey from autofill.
    signIn(section, true).catch(fail);
    return;
  }
  const alt = document.getElementById("passkey-alt");
  const button = document.getElementById("passkey-button");
  if (!alt || !button) return;
  alt.hidden = false;
  button.addEventListener("click", () => {
    WebAuthnAbortService.cancelCeremony();
    signIn(section, false).catch(fail);
  });
}

async function offerPage(section: HTMLElement) {
  const next = section.dataset.next || "/";
  if (!browserSupportsWebAuthn() || !(await platformAuthenticatorIsAvailable())) {
    location.replace(next);
    return;
  }
  document.getElementById("passkey-later")?.addEventListener("click", () => {
    document.cookie = `${LATER_COOKIE}=1; Path=/; Max-Age=${LATER_DAYS * 86400}; Secure; SameSite=Lax`;
  });
  const save = document.getElementById("passkey-save") as HTMLButtonElement | null;
  save?.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const { options, token } = await post<{ options: never; token: string }>("/api/me/passkeys/options", {}, SAVE_FAILED);
      const response = await startRegistration({ optionsJSON: options });
      await post("/api/me/passkeys", { token, response }, SAVE_FAILED);
      location.replace(next);
    } catch (err) {
      // This device already holds one of their passkeys: nothing to save.
      if ((err as { name?: string })?.name === "InvalidStateError") location.replace(next);
      else if (!cancelled(err)) showError((err as Error).message);
    } finally {
      save.disabled = false;
    }
  });
}

const login = document.getElementById("login");
const offer = document.getElementById("passkey-offer");
if (login) void loginPage(login);
if (offer) void offerPage(offer);
