// Keeps motion and sound to the rules in AGENTS.md: one set of tokens, no stray durations, and sound only
// through cue(), so it can't play without its motion.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSoundsCookie, soundsCookie, soundsCookieScope } from "../src/shared/sound.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(path, ext));
    else if (ext.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path);
  }
  return out;
}

const tokens = (css: string) => [...css.matchAll(/(--motion-[a-z]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stripTs = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** A duration written out (150ms, .2s, 1.4s), as opposed to a var(--motion-*) token. */
const RAW_DURATION = /(?<![\w-])\.?\d+(\.\d+)?m?s\b/;

describe("motion tokens", () => {
  test("the shell mirrors the kit's tokens exactly, each defined once", () => {
    const kit = tokens(read("src/kit/theme.css"));
    // Adding a token means adding it here, to shell.css and to the table in AGENTS.md.
    expect(kit.map(([name]) => name).sort()).toEqual(["--motion-attention", "--motion-base", "--motion-data", "--motion-ease", "--motion-fast", "--motion-slow", "--motion-spring"]);
    expect(tokens(read("src/shell/shell.css"))).toEqual(kit);
  });

  test("the feedback motions are the same in the shell and the kit", () => {
    const rules = (css: string) =>
      [...stripCss(css).matchAll(/(\.art-move-(?:pop|glow)|@keyframes art-move-(?:pop|glow))\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => [m[1], m[2].replace(/\s+/g, " ").trim()]);
    const kit = rules(read("src/kit/motion.css"));
    expect(kit.map(([name]) => name)).toEqual([".art-move-pop", "@keyframes art-move-pop", ".art-move-glow", "@keyframes art-move-glow"]);
    expect(rules(read("src/shell/shell.css"))).toEqual(kit);
  });

  test("CSS uses the tokens, not its own durations", () => {
    const bad: string[] = [];
    for (const path of ["src/shell/shell.css", ...files("src/kit", /\.css$/)]) {
      for (const m of stripCss(read(path)).matchAll(/(?:^|[;{\s])((?:transition|animation)[\w-]*)\s*:\s*([^;}]*)/g)) {
        const [, prop, value] = m;
        // The reduced-motion override settles everything at once.
        if (/!important/.test(value) && /^(0\.01ms|0s)\s*!important$/.test(value.trim())) continue;
        // Endless loops (a spinner, the splash ghost) keep their own period. The feedback delay's fallback is 0ms.
        let v = value.replace(/var\(--move-delay, 0ms\)/g, "");
        if (prop.startsWith("animation") && /\binfinite\b/.test(v)) continue;
        v = v.replace(/var\(--motion-[a-z]+\)/g, "");
        if (RAW_DURATION.test(v)) bad.push(`${path}: ${prop}: ${value.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("hover and keyboard focus change colour, never position or size", () => {
    const bad: string[] = [];
    for (const path of ["src/shell/shell.css", ...files("src/kit", /\.css$/)]) {
      // Innermost rules only (selector { declarations }), so a wrapping @media doesn't hide or join them.
      for (const m of stripCss(read(path)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, selector, body] = m;
        if (/:hover|:focus-visible/.test(selector) && /(?:^|[;\s])(transform|translate|scale)\s*:/.test(body)) bad.push(`${path}: ${selector.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("components use the tokens, not Tailwind's numbered durations or inline timings", () => {
    const bad: string[] = [];
    for (const path of files("src", /\.tsx?$/)) {
      stripTs(read(path))
        .split("\n")
        .forEach((line, i) => {
          const where = `${path}:${i + 1}`;
          for (const c of line.match(/\b(duration|delay)-(\d+|\[[^\]]*\])|\bease-(in|out|in-out|linear|\[[^\]]*\])(?![\w-])/g) ?? []) bad.push(`${where}: ${c}`);
          for (const c of line.match(/animate-\[[^\]]*\]/g) ?? []) if (!c.includes("infinite") && RAW_DURATION.test(c.replace(/var\([^)]*\)/g, ""))) bad.push(`${where}: ${c}`);
          // Inline styles and WAAPI: feedback goes through move() and cue(), timings through the tokens.
          if (/\b(transition|animation)(Duration|Delay|TimingFunction)?\s*:\s*["'`]|\.animate\(\s*\[/.test(line)) bad.push(`${where}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });

  test("Listen's wisp times every hop from the tokens and stays within --motion-slow", () => {
    // The wisp (src/kit/wisp.ts) is the one WAAPI user outside move(): a hop per spoken word, built from the
    // word's own timing. Its durations must come from motionMs() (so reduced motion places it without a hop).
    const wisp = stripTs(read("src/kit/wisp.ts"));
    expect(wisp).toMatch(/motionMs\("slow"\)/);
    expect(wisp).toMatch(/motionMs\("fast"\)/);
    expect(wisp).not.toMatch(/\b(duration|delay)\s*:\s*\d/);
    expect(wisp).not.toMatch(/\b\d{2,}\s*ms\b|setTimeout/);
    // Transform and opacity only.
    expect(wisp).not.toMatch(/\b(top|left|width|height|margin)\s*:/);
  });
});

describe("sound", () => {
  const sources = files("src", /\.(tsx?|js|mjs|html)$/).map((path) => ({ path, text: stripTs(read(path)) }));

  test("only src/shared/sound.ts makes audio or vibrates (and Listen plays the speech it was asked for)", () => {
    const makers = sources
      .filter((s) => /AudioContext|HTMLAudioElement|new\s+Audio\s*\(|<audio\b|createOscillator|\.vibrate\b|\bvibrate\s*\(/.test(s.text))
      .map((s) => s.path)
      .sort();
    expect(makers).toEqual([join("src", "shared", "sound.ts"), join("src", "shell", "listen.ts")]);
    // Listen uses an <audio> element, never Web Audio.
    const listen = sources.find((s) => s.path.endsWith("listen.ts"))!.text;
    expect(listen).not.toMatch(/AudioContext|createOscillator/);
  });

  test("only cue() plays a sound, so none plays without its motion", () => {
    const players = sources.filter((s) => /\bplaySound\b/.test(s.text)).map((s) => s.path).sort();
    expect(players).toEqual([join("src", "shared", "motion.ts"), join("src", "shared", "sound.ts")]);
    // In motion.ts, the one call is inside cue(), after its move().
    const motion = sources.find((s) => s.path.endsWith("motion.ts"))!.text;
    expect(motion.match(/playSound\(/g)).toHaveLength(1);
    expect(motion).toMatch(/export function cue\([^)]*\) \{[^}]*if \(!move\([^}]*\) return;\s*playSound\(sound\);\s*\}/);
    // In sound.ts, sound starts only in start(), which only playSound() calls.
    const sound = sources.find((s) => s.path.endsWith("sound.ts"))!.text;
    expect(sound.match(/\.start\(/g)).toHaveLength(1);
    expect(sound.match(/\bstart\(name\)/g)).toHaveLength(2);
    expect(sound).not.toMatch(/export function start\b/);
  });

  test("the preference is one cookie per deployment, shared by its apex and workspaces", () => {
    // Prod: workspaces sit under the apex.
    const prod = soundsCookieScope("artifacts.boo", ".artifacts.boo");
    expect(prod).toEqual({ name: "art_sounds", domain: "artifacts.boo" });
    expect(soundsCookie(true, prod, "team.artifacts.boo")).toBe("art_sounds=1; Path=/; Max-Age=31536000; SameSite=Lax; Secure; Domain=artifacts.boo");
    expect(soundsCookie(false, prod, "artifacts.boo")).toStartWith("art_sounds=0;");
    // A stage (<stage>.artifacts.boo, workspaces <slug>--<stage>.artifacts.boo): the same parent, its own name.
    const stage = soundsCookieScope("motion.artifacts.boo", "--motion.artifacts.boo");
    expect(stage).toEqual({ name: "art_sounds_motion", domain: "artifacts.boo" });
    expect(soundsCookie(true, stage, "motion.artifacts.boo")).toEndWith("; Domain=artifacts.boo");
    expect(soundsCookie(true, stage, "team--motion.artifacts.boo")).toEndWith("; Domain=artifacts.boo");
    // Outside the domain (local dev) the cookie stays with its host; plain http drops Secure.
    expect(soundsCookie(true, prod, "localhost", false)).toBe("art_sounds=1; Path=/; Max-Age=31536000; SameSite=Lax");
    expect(soundsCookie(true, prod, "evilartifacts.boo")).not.toContain("Domain=");
    expect(readSoundsCookie("a=1; art_sounds=1", "art_sounds")).toBe(true);
    expect(readSoundsCookie("art_sounds=0", "art_sounds")).toBe(false);
    expect(readSoundsCookie("xart_sounds=1", "art_sounds")).toBe(false);
    expect(readSoundsCookie("", "art_sounds")).toBe(false);
    // Prod's cookie reaches stage hosts too; the stage reads only its own.
    expect(readSoundsCookie("art_sounds=1; art_sounds_motion=0", stage.name)).toBe(false);
  });
});
