import assert from "node:assert/strict";

/** Fail explicitly when a mutated command exits before reaching its test latch. */
export async function awaitStarted(
  started: Promise<void>,
  execution: Promise<unknown>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      started.then(() => "started"),
      execution.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("deadline"), 1000);
      }),
    ]);
    assert.equal(
      outcome,
      "started",
      "authorized operation must reach the expected asynchronous boundary",
    );
  } finally {
    clearTimeout(timer);
  }
}
