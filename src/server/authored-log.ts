/*
 * The progress lines a running authored ceremony writes to its run's log. They
 * are written one after another in the background, so a slow store does not
 * hold the ceremony up between steps. The run's event stream reads that log
 * once more after the run has settled, so the run must not settle before its
 * lines have landed: the step that writes them waits for `settled()` before it
 * returns, whichever way it returns. A line whose write fails is dropped, as a
 * progress line is not worth failing the step over.
 */

export type ProgressLog = {
  /** Queues one line; the write happens after every line queued before it. */
  log(text: string): void;
  /** Resolves once every line queued so far has been written (or dropped). */
  settled(): Promise<void>;
};

export function progressLog(
  append: (text: string) => Promise<void>,
): ProgressLog {
  let tail: Promise<void> = Promise.resolve();
  return {
    log(text) {
      tail = tail.then(() => append(text)).catch(() => {});
    },
    settled: () => tail,
  };
}
