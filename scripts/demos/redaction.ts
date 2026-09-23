import { rmSync } from "node:fs";

export type Box = { x: number; y: number; w: number; h: number };
export type Redaction = Box & { start: number; end: number };

/**
 * Frames a box is back-dated by even when every poll returns promptly: a
 * frame may be captured between the page painting the value and the read
 * that finds it.
 */
const lead = 12;

/**
 * Where a displayed value sat in the video, and for which frames, built from
 * polls of the page that may return late.
 *
 * A box starts at the latest frame at which the value is *known* not to have
 * been there: the previous poll, which saw nothing or saw it elsewhere, or
 * the action that revealed it, before which it did not exist. Back-dating
 * from the moment a poll happens to return instead leaves every frame
 * captured while that poll was stalled uncovered. A box over the page before
 * the value arrived hides nothing that matters; a missed frame would.
 */
export function redactionTracker(frame: () => number) {
  const boxes: Redaction[] = [];
  let open: (Box & { start: number }) | undefined;
  /** When the last completed poll was asked. */
  let asked = frame();
  let revealedAt: number | undefined;
  let located = true;
  const close = () => {
    if (open) boxes.push({ ...open, end: frame() });
    open = undefined;
  };
  return {
    boxes,
    /** Whether a reveal was applied and the value was never found after it. */
    get unlocated() {
      return !located;
    },
    /** The action that puts the value on the page is being applied now. */
    revealing() {
      revealedAt = frame();
      located = false;
    },
    /** A poll asked at frame `at` found the value at `found`, or nowhere. */
    seen(found: Box | null, at: number) {
      const since = Math.max(asked, revealedAt ?? 0);
      asked = at;
      if (found) located = true;
      const same =
        found &&
        open &&
        Math.abs(found.x - open.x) < 1 &&
        Math.abs(found.y - open.y) < 1 &&
        Math.abs(found.w - open.w) < 1;
      if (same) return;
      close();
      if (!found) return;
      open = { ...found, start: Math.max(0, Math.min(frame() - lead, since)) };
    },
    stop() {
      close();
    },
  };
}

/**
 * Run the steps that turn the raw recording into the published video, and
 * delete whatever is at `video` if any of them fails. The composed video is
 * written before the redaction boxes are drawn over it, so a failed overlay
 * would otherwise leave a video showing the value at the path a caller
 * publishes from.
 */
export async function removeUnlessFinished(
  video: string,
  produce: () => Promise<void>,
): Promise<void> {
  try {
    await produce();
  } catch (error) {
    rmSync(video, { force: true });
    throw error;
  }
}
