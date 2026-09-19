import assert from "node:assert/strict";
import test from "node:test";
import { importServerJson } from "../../../src/server/connectors/registries/mcp/import.js";
import { exportDefinitionProjection } from "../../../src/core/connectors/projections.js";

/*
 * SEC-F3. The importer used to redact a declared value only when the publisher
 * set `isSecret`, while the publication projection in the same module also
 * applied a name heuristic. Two surfaces, one module, two different ideas of
 * what a secret is: a publisher who pasted a credential into a value and
 * forgot the flag got it stored verbatim and republished by the
 * native-extension export.
 *
 * The canary is a literal string with no meaning outside this file, so an
 * assertion that it is absent is an assertion about this code and not about a
 * real credential.
 */

const PROVENANCE = {
  sourceRef: "src:mcp-registry:sec-f3",
  origin: {
    kind: "registry" as const,
    location: "https://registry.example.com",
  },
};

const UNMARKED = "canary-unmarked-must-not-survive";
const MARKED = "canary-marked-must-not-survive";

function serverJson(): unknown {
  return {
    $schema:
      "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
    name: "io.github.example/canary",
    description: "A server whose publisher was careless with a value.",
    version: "1.0.0",
    packages: [
      {
        registryType: "npm",
        identifier: "example-canary",
        version: "1.0.0",
        transport: { type: "stdio" },
        environmentVariables: [
          // No isSecret. The name is what gives it away.
          { name: "GITHUB_TOKEN", value: UNMARKED },
          { name: "MARKED_SECRET", value: MARKED, isSecret: true },
          // Not a credential by any reading: it must survive, or the
          // heuristic has become a shredder.
          { name: "LOG_LEVEL", value: "debug" },
        ],
      },
    ],
  };
}

test("SEC-F3: an unmarked credential-named value is redacted like a marked one", async () => {
  const result = await importServerJson(serverJson(), PROVENANCE);
  assert.ok("definition" in result, "the canary server imports");
  const text = JSON.stringify(result.definition);

  assert.ok(!text.includes(UNMARKED), "an unmarked credential value survived");
  assert.ok(!text.includes(MARKED), "a marked credential value survived");
  // A value nobody would call a credential is still carried, so the fix did
  // not become "redact everything".
  assert.ok(text.includes("debug"), "an ordinary value was redacted too");

  // The redaction is visible, not silent: a reviewer can see a value was
  // removed and restore it if the name misled the heuristic. The issue list
  // deduplicates by code, so one `security.secret-value-redacted` covers both
  // removals rather than one per removal.
  assert.ok(
    result.definition.compatibility.issues.some(
      (issue) => issue.code === "security.secret-value-redacted",
    ),
    "a redaction happened and no reviewer was told",
  );
  // The field names survive, which is how a reviewer knows what was there.
  assert.ok(text.includes("GITHUB_TOKEN"), "the redacted field name is kept");
  assert.ok(text.includes("MARKED_SECRET"), "the redacted field name is kept");
});

test("SEC-F3: the native-extension export no longer republishes the value", async () => {
  const result = await importServerJson(serverJson(), PROVENANCE);
  assert.ok("definition" in result);
  // The operator opt-in that carried the value before. This is the surface
  // the finding named, so it is asserted directly rather than inferred from
  // the definition above.
  const exported = JSON.stringify(
    exportDefinitionProjection(result.definition, {
      includeNativeExtensions: true,
    }),
  );
  assert.ok(!exported.includes(UNMARKED));
  assert.ok(!exported.includes(MARKED));
});

test("SEC-F3: a credential-named requirement is classified secret, not public", async () => {
  const result = await importServerJson(serverJson(), PROVENANCE);
  assert.ok("definition" in result);
  const requirement = result.definition.configuration.find(
    (item) => item.name === "GITHUB_TOKEN",
  );
  if (requirement)
    assert.equal(
      requirement.classification,
      "secret",
      "an unmarked credential was reported as a public configuration value",
    );
});
