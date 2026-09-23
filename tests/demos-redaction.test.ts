import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  redactionTracker,
  removeUnlessFinished,
} from "../scripts/demos/redaction.js";

/**
 * The redaction a demo video draws over a value a provider page displays.
 * Nothing here records: the tracker is fed frame numbers and positions the
 * way the harness's poll feeds it, so a stalled poll can be staged exactly.
 */

const field = { x: 100, y: 200, w: 300, h: 32 };

test("DEMO-REDACT: a poll that stalls past the reveal still boxes every frame from the reveal", () => {
  let frame = 0;
  const tracker = redactionTracker(() => frame);
  frame = 40;
  // The driver presses "Generate a new client secret" here.
  tracker.revealing();
  // The page paints the secret at once; the poll asked at 45 stalls and
  // returns only at 100. Back-dating from 100 alone would miss 45 frames.
  frame = 100;
  tracker.seen(field, 45);
  frame = 150;
  tracker.stop();
  assert.deepEqual(tracker.boxes, [{ ...field, start: 40, end: 150 }]);
  assert.equal(tracker.unlocated, false);
});

test("DEMO-REDACT: a field that moves is boxed from the last poll that saw where it was", () => {
  let frame = 0;
  const tracker = redactionTracker(() => frame);
  frame = 10;
  tracker.seen(field, 10);
  // A poll asked at 20 stalls; it returns at 90 with the field moved.
  frame = 90;
  const moved = { ...field, y: 260 };
  tracker.seen(moved, 20);
  frame = 120;
  tracker.stop();
  assert.deepEqual(tracker.boxes, [
    { ...field, start: 0, end: 90 },
    // Not 90 - 12: the move happened some time after the poll at 10 returned.
    { ...moved, start: 10, end: 120 },
  ]);
});

test("DEMO-REDACT: a reveal whose value was never located refuses the take", () => {
  let frame = 0;
  const tracker = redactionTracker(() => frame);
  frame = 30;
  tracker.revealing();
  frame = 90;
  tracker.seen(null, 80);
  tracker.stop();
  assert.deepEqual(tracker.boxes, []);
  assert.equal(tracker.unlocated, true);
});

test("DEMO-REDACT: a video whose overlay failed is not left at the output path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ceremony-redaction-test-"));
  try {
    const video = join(directory, "demo.mp4");
    await assert.rejects(
      removeUnlessFinished(video, async () => {
        // Composed, unredacted, then the overlay fails.
        writeFileSync(video, "unredacted");
        throw new Error("ffmpeg failed");
      }),
      /ffmpeg failed/,
    );
    assert.equal(existsSync(video), false);

    await removeUnlessFinished(video, async () => {
      writeFileSync(video, "redacted");
    });
    assert.equal(existsSync(video), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
