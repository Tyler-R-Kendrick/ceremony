import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { AsyncCeremonyStore } from "../src/server/persistence/index.js";

/*
 * An authored ceremony writes its progress lines to the run's log while it
 * runs, and the run's event stream reads that log once more after the run has
 * settled. If the run settled before its own log writes landed, the stream
 * could end with none of them, which is what a slow store did under load.
 * Here every log write is held well past the stream's last read, so the only
 * way the line can reach the stream is the run waiting for its log first.
 */

const LOG_WRITE_DELAY_MS = 1_500;

test("the run's progress lines are in its stream even when every log write is slow", async (t) => {
  const { teachingGitHubFixture } =
    await import("./fixtures/teaching-github.js");
  const fixture = await teachingGitHubFixture(4502, {
    browser: {
      complete: async () => ({ status: "blocked" as const, reason: "session" }),
    },
    inbox: {
      provision: async () => "agent-1@inbox.test",
      latest: async () => undefined,
    },
  });
  t.after(() => fixture.close());
  // The runtime holds this very object, so its transactions go through here.
  const store: AsyncCeremonyStore = fixture.store;
  const transaction = store.transaction.bind(store);
  let delayed = 0;
  store.transaction = (work) =>
    transaction((tx) =>
      work({
        ...tx,
        put: async (key, value, revision) => {
          if (key.id.startsWith("authored-log:")) {
            delayed++;
            await sleep(LOG_WRITE_DELAY_MS);
          }
          return tx.put(key, value, revision);
        },
      }),
    );
  const headers = {
    cookie: fixture.sessionCookie("http-author"),
    origin: fixture.origin,
    "content-type": "application/json",
  };
  const chat = await fetch(`${fixture.origin}/api/v1/teaching/authoring/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "create a ceremony for bluesky" }),
  });
  assert.equal(chat.status, 200);
  const started = await fetch(`${fixture.origin}/api/v1/teaching/runs`, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify({ connectorId: "bluesky", ceremony: "oauth-code" }),
  });
  assert.equal(started.status, 200);
  const body = await started.text();
  for (const line of [
    "Running the oauth-code ceremony in the isolated browser",
    "No stored account; registering one with the agent inbox first",
  ])
    assert.ok(body.includes(line), `${line}: ${body.slice(0, 600)}`);
  assert.ok(
    delayed >= 2,
    `the log writes went through the slow store: ${delayed}`,
  );
});
