import assert from "node:assert/strict";
import test from "node:test";
import { codeFrom, issuedBy } from "../examples/agent-run.js";
import { openBrowserSession } from "../examples/browser-session.js";
import { ConnectorError } from "../src/server/connectors/errors.js";
import { MAX_RESPONSE_BYTES } from "../src/server/connectors/auth/response-bound.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
  type Sites,
} from "./connectors/doubles/endless-body.js";

/*
 * The example agent reads three answers that carry a credential or open a
 * session: the confirmation code in the reference provider's mailbox, the
 * credential that provider issues, and the remote browser session Browser Use
 * opens. Each is read under the OAuth ceiling, so a server that never stops
 * cannot decide how much the example holds.
 */

const MAILBOX: Sites = ["examples/agent-run.ts#codeFrom"];
const ISSUE: Sites = ["examples/agent-run.ts#issuedBy"];
const SESSION: Sites = ["examples/browser-session.ts#openBrowserSession"];

/** `fetch` answering every request without end for the length of `work`; what `work` failed with. */
async function againstEndless(
  work: () => Promise<unknown>,
  sites: Sites,
): Promise<{ failure: unknown; seen: Pulled }> {
  const seen: Pulled = { pulled: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = endlessFetch(seen, sites);
  try {
    const failure = await work().then(
      () => undefined,
      (error: unknown) => error ?? new Error("no failure"),
    );
    return { failure, seen };
  } finally {
    globalThis.fetch = original;
  }
}

test("a mailbox page that never ends is cut off at the ceiling, and no code is read from it", async () => {
  const { failure, seen } = await againstEndless(
    () => codeFrom("http://127.0.0.1:4174", "agent@ceremony.test"),
    MAILBOX,
  );
  assert.ok(
    failure instanceof ConnectorError &&
      failure.detail === "example.inbox.too-large",
    `expected the mailbox refusal, got ${String(failure)}`,
  );
  assertReadUnder(assert, seen, MAX_RESPONSE_BYTES, "the mailbox");
});

test("a credential answer that never ends is cut off at the ceiling, and issues nothing", async () => {
  const { failure, seen } = await againstEndless(
    () => issuedBy("http://127.0.0.1:4174", "agent@ceremony.test", "pw"),
    ISSUE,
  );
  assert.ok(failure, "the oversized answer is refused");
  assertReadUnder(assert, seen, MAX_RESPONSE_BYTES, "the credential answer");
});

test("a Browser Use session answer that never ends is cut off at the ceiling", async () => {
  const { failure, seen } = await againstEndless(
    () => openBrowserSession({ BROWSER_USE_API_KEY: "synthetic-key" }),
    SESSION,
  );
  assert.ok(failure, "the oversized answer is refused");
  assertReadUnder(assert, seen, MAX_RESPONSE_BYTES, "the session answer");
});
