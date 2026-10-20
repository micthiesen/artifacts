// UI sounds, synthesised with Web Audio: no audio files to fetch or decode.
// Only cue() in motion.ts plays them, so a sound always starts with its motion
// (see AGENTS.md). Off unless the viewer turned Sounds on (a per-device cookie),
// quiet, short, and silenced by an iPhone's silent switch like other web audio.

export type SoundName = "send" | "approve" | "arrive" | "toggle";

/** One partial: a frequency (gliding to `to`), starting `at` seconds in, decaying over `len` seconds. */
type Tone = { type: OscillatorType; f: number; to?: number; at: number; len: number; gain: number };

const RECIPES: Record<SoundName, Tone[]> = {
  // Your comment or response went out: a short rising blip.
  send: [{ type: "sine", f: 540, to: 860, at: 0, len: 0.09, gain: 0.22 }],
  // An approval: two notes a fifth apart.
  approve: [
    { type: "sine", f: 660, at: 0, len: 0.11, gain: 0.18 },
    { type: "sine", f: 990, at: 0.07, len: 0.16, gain: 0.16 },
  ],
  // Someone else changed something you can see: a soft high tick, the quietest sound.
  arrive: [{ type: "triangle", f: 1320, to: 1180, at: 0, len: 0.06, gain: 0.07 }],
  // Sounds were just turned on.
  toggle: [{ type: "triangle", f: 880, at: 0, len: 0.05, gain: 0.14 }],
};

/** Shortest gap between two plays of one sound, so bursts (a run of remote edits) don't chatter. */
const MIN_GAP_MS: Record<SoundName, number> = { send: 80, approve: 80, arrive: 1500, toggle: 80 };
const MASTER = 0.6;

let enabled = false;
let ctx: AudioContext | null = null;
let listening = false;
const lastPlayed = new Map<SoundName, number>();

export function soundsEnabled(): boolean {
  return enabled;
}

export function setSoundsEnabled(on: boolean) {
  enabled = on;
  // Off: let go of the output device, so the tab doesn't keep an audio session open.
  if (!on) void ctx?.suspend().catch(() => {});
  if (!on || listening || typeof document === "undefined") return;
  // Browsers only start audio inside a user gesture (iOS: a click or touchend, not pointerdown): resume on the
  // next one wherever it lands in this document. The shell and the artifact frame are separate documents, so
  // each one starts its own audio after a gesture of its own.
  listening = true;
  for (const type of ["pointerdown", "touchend", "click", "keydown"]) document.addEventListener(type, unlockAudio, { capture: true, passive: true });
}

/** Creates or resumes the audio context. Only works inside a user gesture, which is why it runs on every one. */
export function unlockAudio() {
  if (!enabled || typeof AudioContext === "undefined") return;
  ctx ??= new AudioContext({ latencyHint: "interactive" });
  // "suspended" before the first gesture, "interrupted" on iOS after a call or Siri.
  if (ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => {});
}

/** Seconds between starting a sound and hearing it (Bluetooth output can be a fifth of a second). */
export function soundLatency(): number {
  if (!enabled || !ctx || ctx.state !== "running") return 0;
  return ctx.outputLatency || ctx.baseLatency || 0;
}

/** Whether playSound(name) would play right now. */
export function willPlay(name: SoundName): boolean {
  return enabled && ctx?.state === "running" && performance.now() - (lastPlayed.get(name) ?? -Infinity) >= MIN_GAP_MS[name];
}

/** Plays a sound now, if sounds are on and audio is running. Returns whether it played. Call through cue(). */
export function playSound(name: SoundName): boolean {
  if (!enabled || !ctx) return false;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < MIN_GAP_MS[name]) return false;
  if (ctx.state !== "running" && ctx.state !== "closed") {
    // The gesture that unlocks audio is often the one that asked for this sound: play it if the context starts at
    // once, and drop it if not, rather than let it trail its motion.
    void ctx.resume().then(
      () => {
        if (performance.now() - now < 50) start(name);
      },
      () => {},
    );
    return false;
  }
  if (ctx.state === "closed") return false;
  start(name);
  return true;
}

function start(name: SoundName) {
  if (!ctx) return;
  lastPlayed.set(name, performance.now());
  const out = ctx.createGain();
  out.gain.value = MASTER;
  out.connect(ctx.destination);
  // A slight random detune so a sound heard often doesn't grate.
  const detune = 1 + (Math.random() - 0.5) * 0.04;
  const start = ctx.currentTime + 0.005;
  for (const t of RECIPES[name]) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const at = start + t.at;
    osc.type = t.type;
    osc.frequency.setValueAtTime(t.f * detune, at);
    if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to * detune, at + t.len);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(t.gain, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + t.len);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + t.len + 0.02);
  }
}

/** Where the per-device preference lives: one cookie that the apex and every workspace of a deployment read. */
export type SoundsCookie = { name: string; domain: string };

/**
 * The deployment's cookie, worked out by the Worker from its apex host and workspace suffix. Prod (apex
 * artifacts.boo, workspaces <slug>.artifacts.boo) shares artifacts.boo as `art_sounds`. A stage (apex
 * <stage>.artifacts.boo, workspaces <slug>--<stage>.artifacts.boo) also shares artifacts.boo, so its cookie is
 * named for the stage and never mixes with prod's.
 */
export function soundsCookieScope(apexHost: string, workspaceSuffix: string): SoundsCookie {
  const a = apexHost.split(".").reverse();
  const b = workspaceSuffix.replace(/^[^.]*\./, "").split(".").reverse();
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  const domain = a.slice(0, n).reverse().join(".");
  const extra = apexHost === domain ? "" : apexHost.slice(0, -domain.length - 1);
  return { name: extra ? `art_sounds_${extra.replace(/[^a-z0-9]/gi, "_")}` : "art_sounds", domain };
}

export function readSoundsCookie(cookie: string, name: string): boolean {
  return cookie.split(/;\s*/).find((c) => c.startsWith(`${name}=`)) === `${name}=1`;
}

/** Cookie string that remembers the choice for a year; a page outside the domain (local dev) keeps it to itself. */
export function soundsCookie(on: boolean, scope: SoundsCookie, host: string, secure = true): string {
  const shared = host === scope.domain || host.endsWith(`.${scope.domain}`);
  return `${scope.name}=${on ? "1" : "0"}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}${shared ? `; Domain=${scope.domain}` : ""}`;
}

/** The scope a page's account slot carries (data-sounds-cookie and data-sounds-domain). */
export function soundsScopeOf(slot: HTMLElement | null): SoundsCookie {
  return { name: slot?.dataset.soundsCookie || "art_sounds", domain: slot?.dataset.soundsDomain || location.hostname };
}
