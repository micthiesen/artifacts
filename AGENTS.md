# artifacts.boo

`docs/DESIGN.md` explains what the system is for and why; `docs/guide.md` is
what agents writing artifacts are told (served by the `artifact_guide` MCP
tool, with `src/kit/CATALOG.md`).

Checks: `bun run typecheck`, `bun test`, `bun run build`. After UI changes,
run `spikes/e2e-layout.ts` against a running stage: pages must never scroll
sideways on a phone.

## Motion, sound and haptics

Feedback, not decoration. Every animation and sound answers "what just
changed, and where?" The rules below are enforced by `test/motion.test.ts`
where a test can catch them; keep the rest by hand.

**Motion explains change.**

- Animate things arriving, leaving and moving, and other people's changes
  reaching the page. Never animate on page load, on scroll, or for
  decoration. The splash page's drifting ghost is the one exception.
- Keyboard-driven and very frequent actions (typing, arrowing, hovering a
  list) get colour changes at most, not movement.
- Animate `transform` and `opacity`; never animate layout (height, width,
  top), so nothing reflows.
- Prefer CSS: transitions, `@starting-style`, keyframes, and same-document
  View Transitions for reordering. No animation libraries.

**One scale.** Durations and curves are the `--motion-*` tokens in
`src/kit/theme.css`, mirrored in `src/shell/shell.css`:

| Token | Value | Use |
|---|---|---|
| `--motion-fast` | 120ms | hover, press, colour (Tailwind's default `transition-*` duration) |
| `--motion-base` | 180ms | menus, popovers, dialogs, toasts, rows coming and going |
| `--motion-slow` | 280ms | panels, feedback cues |
| `--motion-data` | 500ms | a bar or meter settling on a new value |
| `--motion-attention` | 1200ms | a highlight fading out |
| `--motion-ease` | ease-out curve | almost everything |
| `--motion-spring` | `linear()` spring, 4% overshoot | things arriving |

In Tailwind write `duration-(--motion-base) ease-(--motion-ease)`, never
`duration-150`. Nothing runs longer than `--motion-slow` except data bars and
attention highlights. Only endless loops (spinners) may use their own
duration.

**Reduced motion.** Both stylesheets collapse every animation and transition
under `prefers-reduced-motion: reduce`. Code that waits on a transition reads
the token with `motionMs()` (`src/shared/motion.ts`), which returns 0 then.

**Feedback cues.** `src/shared/motion.ts` has two motions: `pop` (something
you did just landed) and `glow` (someone else changed this). Their keyframes
are the `.art-move-*` classes in `src/kit/motion.css` and `shell.css`.

- `move(el, motion)` runs a motion alone.
- `cue(el, sound)` runs a sound with its motion.
- In the kit, `useArrivals` (`src/kit/feedback.ts`) glows a component's
  elements when shared state under its key changes remotely. The shell marks
  such changes `remote`; your own writes coming back are not arrivals.

**No sound without motion.**

- `cue()` is the only caller of `playSound()`. It starts the sound and the
  motion in the same frame, and delays the motion by the output latency when
  that's over 40 ms (Bluetooth), so they land together.
- `src/shared/sound.ts` is the only file that touches Web Audio.
- Sounds are synthesised from short recipes in code. Never add audio files or
  a sound library.

**Sound is rare, short and quiet.**

- There are four sounds:
  - `send`: your comment, response or ledger entry went out
  - `approve`: your approval
  - `arrive`: someone else's change or comment reached the page; throttled to
    one per 1.5 s
  - `toggle`: Sounds were turned on
- Each sound is under about 150 ms, at low gain.
- Never play a sound for hover, typing, navigation, ticking a box, voting or
  errors. Add a fifth sound only for a new kind of event that matters as much
  as these.
- A sound never carries information the screen doesn't also show.

**Respect the person.**

- Sounds are off until the viewer turns on Sounds in the account menu. The
  choice is per device: one cookie that the apex and every workspace of a
  deployment read. It is `art_sounds` in prod; a stage gets its own name.
  The Worker works it out (`soundsCookieScope`) and puts it on the account
  slot.
- Web Audio follows the iPhone silent switch. Keep it that way: don't set
  `navigator.audioSession`.
- Audio starts only after a user gesture in the same document. The shell and
  the artifact frame each unlock their own, so the frame stays silent until
  the reader first clicks or types inside it. Don't add `allow="autoplay"` to
  the frame to get around this: it would let artifact code play audio
  unasked.
- A hidden tab plays nothing, and doesn't save arrivals up for when it comes
  back.
- Own-action cues follow the optimistic write, like the rest of the UI.

**Haptics: none.** iOS Safari has no vibration API, and Apple closed the
scripted switch workaround in iOS 26.5. `navigator.vibrate` is blocked in the
cross-origin frames artifacts run in. Revisit when a web haptics standard
ships.

**Artifacts.** Artifact authors get this through `docs/guide.md`: use the
motion tokens, rely on the kit's live components for feedback, and never make
sounds of their own.
