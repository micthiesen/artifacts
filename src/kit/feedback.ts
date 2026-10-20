// Feedback for the kit's live components: other people's changes glow as they
// arrive, and your own sends and approvals get their cue (src/shared/motion.ts).
import { useEffect, useRef, type RefObject } from "react";
import { cue, move } from "../shared/motion.ts";
import type { SoundName } from "../shared/sound.ts";
import * as store from "./store.ts";

/**
 * Shows changes someone else makes to `key` or anything under `key/` arriving: the element `find` returns for
 * the rest of the key (or `root`) glows, and the first one gets the arrival sound.
 */
export function useArrivals(root: RefObject<HTMLElement | null>, key: string | null, find?: (rest: string, root: HTMLElement) => Element | null) {
  const finder = useRef(find);
  finder.current = find;
  useEffect(() => {
    if (key === null) return;
    const prefix = `${key}/`;
    return store.onRemoteChange((keys) => {
      const el = root.current;
      if (!el?.isConnected) return;
      const targets = new Set<Element>();
      for (const k of keys) {
        if (k === key) targets.add(el);
        else if (k.startsWith(prefix)) targets.add(finder.current?.(k.slice(prefix.length), el) ?? el);
      }
      let first = true;
      for (const t of targets) {
        if (first) cue(t, "arrive");
        else move(t, "glow");
        first = false;
      }
    });
  }, [root, key]);
}

/** Plays a cue on what `find` returns once the change just made has rendered. */
export function cueAfterRender(find: () => Element | null | undefined, sound: SoundName) {
  requestAnimationFrame(() => cue(find(), sound));
}

/** Runs a motion (no sound) on what `find` returns once the change just made has rendered. */
export function moveAfterRender(find: () => Element | null | undefined) {
  requestAnimationFrame(() => move(find(), "pop"));
}
