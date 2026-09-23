import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnectorClient } from "../../../src/core/connectors/client.js";
import { createHarness, FIXTURE_DOCUMENT, human } from "./harness.js";

/*
 * The browser client against the real handler, for the definition list.
 *
 * The service lists definitions as summaries (reference, identity, display
 * and issue counts); the client used to parse that list as full normalized
 * definitions, so every call failed as an invalid response. The UX fixture
 * served full definitions too, which is why nothing noticed. This drives the
 * client through the handler itself, so the two cannot drift apart again.
 */

const SESSION = "client-definitions-author";

test("the client reads the definition list the handler actually returns", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  harness.register(SESSION, human());
  const imported = await harness.fetch("/api/v1/connectors/import", {
    session: SESSION,
    body: {
      kind: "upload",
      mediaType: "application/json",
      text: FIXTURE_DOCUMENT(harness.provider.origin),
    },
  });
  assert.equal(imported.status, 200);
  const { definitions: importedRefs } = (await imported.json()) as {
    definitions: string[];
  };

  const api = createConnectorClient({
    online: () => true,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://app.test");
      return harness.fetch(`${url.pathname}${url.search}`, {
        method: init?.method ?? "GET",
        session: SESSION,
      });
    }) as typeof fetch,
  });

  const { definitions } = await api.definitions();
  assert.deepEqual(
    definitions.map((entry) => entry.definitionRef).sort(),
    [...importedRefs].sort(),
  );
  for (const entry of definitions) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "definitionRef",
      "display",
      "identity",
      "issues",
    ]);
    for (const count of Object.values(entry.issues))
      assert.ok(Number.isInteger(count) && count >= 0);
  }
  // The full definition is still one request away, by its reference.
  const review = await api.definition(definitions[0]!.definitionRef);
  assert.equal(review.definition.definitionRef, definitions[0]!.definitionRef);
});
