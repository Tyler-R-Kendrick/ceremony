import { setTimeout as sleep } from "node:timers/promises";

/*
 * The progress lines a running authored ceremony writes to its run's log. They
 * are written one after another in the background, so a slow store does not
 * hold the ceremony up between steps. The run's event stream reads that log
 * once more after the run has settled, so the run must not settle before its
 * lines have landed: the step that writes them waits for `settled()` before it
 * returns, whichever way it returns. A line whose write fails is dropped, as a
 * progress line is not worth failing the step over.
 *
 * The wait is bounded, for the same reason: a store whose write never settles
 * must not hold the run open for ever over progress lines. After
 * `SETTLE_TIMEOUT_MS` it gives up, says how many lines were never written
 * (a count, never a line), and returns; it never fails, so it cannot replace
 * the error of the step that waits for it.
 */

/** The longest `settled()` waits for the lines still being written. */
export const SETTLE_TIMEOUT_MS = 5_000;

export type ProgressLog = {
  /** Queues one line; the write happens after every line queued before it. */
  log(text: string): void;
  /** Resolves once every line queued so far has been written (or dropped), or the bound has passed. */
  settled(): Promise<void>;
};

export type ProgressLogOptions = {
  /** Waits `ms`, and stops waiting when `signal` aborts; a test injects its own. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Told how many lines were never written when the bound passed first. */
  warn?: (unwritten: number) => void;
};

const waitFor = (ms: number, signal: AbortSignal) =>
  sleep(ms, undefined, { signal });

const warnOnStderr = (unwritten: number) =>
  process.stderr.write(
    `authored progress log: ${unwritten} line(s) not written within ${SETTLE_TIMEOUT_MS} ms\n`,
  );

export function progressLog(
  append: (text: string) => Promise<void>,
  { wait = waitFor, warn = warnOnStderr }: ProgressLogOptions = {},
): ProgressLog {
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  let finished = 0;
  return {
    log(text) {
      queued++;
      tail = tail
        .then(() => append(text))
        .catch(() => {})
        .then(() => {
          finished++;
        });
    },
    async settled() {
      const stop = new AbortController();
      const bound = wait(SETTLE_TIMEOUT_MS, stop.signal).then(
        () => "late" as const,
        () => "settled" as const,
      );
      const first = await Promise.race([
        tail.then(() => "settled" as const),
        bound,
      ]);
      stop.abort();
      if (first === "late") warn(queued - finished);
    },
  };
}
