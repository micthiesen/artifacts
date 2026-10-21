# artifacts.boo

`docs/DESIGN.md` explains what the system is for and why; `docs/guide.md` is
what agents writing artifacts are told (served by the `artifact_guide` MCP
tool, with `src/kit/CATALOG.md`).

Checks: `bun run typecheck`, `bun test`, `bun run build`. After UI changes,
run `spikes/e2e-layout.ts` against a running stage: pages must never scroll
sideways on a phone.

## Look

Light means life. Night-ink surfaces and moonlit text stay quiet; only
living things glow, and the colour of the light says whose it is: moon
white for the agent (the ghost), iris (`--primary`) for you, aqua
(`--others`) for other people. Keep these by hand:

- No gradient fills: buttons, rules, rings, text and underlines are solid.
  Soft radial light (the ghost's halo, the page's top glow) and a chart's
  area fade are the only gradients. Chart series colours carry no meaning
  about who; they are just series. The shine on a person's ghost is a drawn crescent, not a
  gradient.
- Fraunces (`--font-display`, soft terminals) is for page and section
  headings and the wordmark only. Controls, labels, tables and numbers stay
  Inter.
- No eyebrow labels over headings, no coloured stripes down a card's edge,
  no rows of identical cards where ruled rows or one divided panel will do.
- The logo is the ghost in moon white with happy closed eyes and blush
  (`src/shell/icons/logo.svg`; `logo-small.svg` draws the face heavier for
  16 to 24 px). The agent appears as the logo.
- People appear as the same ghost without a face, in their own colour
  (`whoColor` in `src/shared/who.ts`), with their initials. A ghost avatar
  is as tall as the round one it replaced, and rows centre their first
  line on it, so wrapped text never floats the avatar.

## Controls, type and accessibility

These hold for the shell and the kit alike. They keep slipping back in, so
check new UI against them.

**Touch and hover.**

- Text fields, textareas and selects are at least 16px on touch screens (both
  stylesheets force it under `pointer: coarse`). iOS zooms into anything
  smaller and the page then scrolls sideways. Never cap zoom in the viewport
  meta instead.
- Nothing is hover-only. A control revealed on hover also shows on
  `:focus-visible` and on touch (`pointer-coarse:` in the kit,
  `@media (hover: none)` in the shell). Tailwind's `hover:` never fires on
  touch, so a hover-only button is an invisible tap target. The same goes
  for information in a tooltip: who voted, who ticked it.
- Tap targets are at least 24px. Grow a small control's hit area with a
  pseudo-element, not by enlarging what you see. Checkboxes come with
  clickable text.
- Presses get a colour change on `:active`, never movement.

**Contrast and focus.**

- Text is at least 4.5:1 on its surface; field borders, focus indicators and
  state indicators at least 3:1. Compute it from the tokens against
  `--background`, `--card` and `--popover`; don't eyeball it.
- `--primary` has the same lightness as `--muted-foreground`, so links in
  running text are underlined. Navigation, footers and button-like links
  aren't.
- Every keyboard focus shows a ring, outline or `--primary` border
  (`focus-halo` in the kit, a 2px `--primary` outline in shell menus). A `--muted` background change alone
  is about 1.1:1 and doesn't count.
- Colour never carries meaning alone: pair it with a sign, icon or word.

**Forms and failures.**

- Never throw away what someone typed. Clear an input only after the send
  is accepted; when a send fails or a drawer closes, keep the text.
- A field's error sits directly under it, the field gets `aria-invalid`, and
  focus moves there. Status and errors are announced (`role="status"`, or
  `role="alert"` when blocking).
- A button that starts a request can't be pressed twice while it runs
  (`aria-busy`). Deleting what people wrote asks first or offers Undo.
- Mark optional fields "(optional)", not required ones with a bare asterisk.

**Type and shape.**

- Headings balance and paragraphs wrap `pretty` by default (base styles).
  Don't fix a line break with `<br>` or `&nbsp;`.
- Digits in a column or that change live get `tabular-nums`. Uppercase is
  for short labels, with at least 0.05em tracking.
- A rounded item inside a padded rounded container uses the container's
  radius minus its padding and border, or its corners look fat.
- Cards, menus, popovers and toasts take their shadow from `--shadow-card`
  or `--shadow-pop`, so elevation reads the same everywhere.

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
- Things that open and close (menus, popovers, panels, sheets) use
  transitions, not keyframes, so they reverse when someone changes their
  mind. In shell CSS, toggle `hidden` with `@starting-style` and
  `transition-behavior: allow-discrete` on `display`. Popovers grow from
  their trigger. Exits may be one step faster than entrances.
- Third-party components bring their own animation defaults: switch them
  off or set them to the tokens (Recharts charts run with
  `isAnimationActive={false}`).

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
- A change of yours the server refuses rolls back. Where something was
  there before, it glows as it snaps back, with no sound; the bar's status
  says why in the error colour.

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
