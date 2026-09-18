import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestEquivalences } from "../../../src/server/connectors/registries/cross-source.js";
import type { DiscoveredItem } from "../../../src/server/connectors/adapter.js";

/*
 * CAT-05. Suggestions are data for a reviewer. These tests pin both halves of
 * that: listings that share a stable source identity are suggested, listings
 * that share only a display name are not, and nothing in the result merges
 * authority, custody or verification.
 */

function item(
  overrides: Partial<DiscoveredItem> & {
    ecosystem: string;
    nativeId: string;
  },
): DiscoveredItem {
  const { ecosystem, nativeId, ...rest } = overrides;
  return {
    identity: {
      ecosystem,
      authorityNamespace: rest.identity?.authorityNamespace ?? "",
      nativeId,
      nativeVersion: rest.identity?.nativeVersion ?? "unversioned",
    },
    displayName: rest.displayName ?? nativeId,
    description: rest.description ?? "",
    ...(rest.provenance ? { provenance: rest.provenance } : {}),
    ...(rest.status ? { status: rest.status } : {}),
  };
}

const smitheryNotion = item({
  ecosystem: "smithery",
  nativeId: "notion/notion-mcp",
  displayName: "Notion",
  provenance: {
    qualifiedName: "notion/notion-mcp",
    repositoryUrl: "https://github.com/makenotion/notion-mcp-server",
    remoteUrl: "https://mcp.notion.com/mcp",
  },
});
const pulseNotion = item({
  ecosystem: "pulsemcp",
  nativeId: "Notion",
  displayName: "Notion",
  provenance: {
    repositoryUrl:
      "https://github.com/makenotion/notion-mcp-server/tree/main/packages/server",
    remoteUrl: "https://mcp.notion.com/mcp?version=2",
  },
});
const dockerNotion = item({
  ecosystem: "docker-mcp",
  nativeId: "notion",
  displayName: "Notion",
  provenance: {
    sourceRepository: "https://github.com/makenotion/notion-mcp-server.git",
  },
});

test("listings sharing a repository and a remote origin are suggested with high confidence", () => {
  const suggestions = suggestEquivalences([
    smitheryNotion,
    pulseNotion,
    dockerNotion,
  ]);
  assert.equal(suggestions.length, 1);
  const suggestion = suggestions[0]!;
  assert.deepEqual(
    suggestion.members.map((member) => member.ecosystem).sort(),
    ["docker-mcp", "pulsemcp", "smithery"],
  );
  assert.equal(suggestion.confidence, "high");
  const kinds = suggestion.reasons.map((reason) => reason.kind).sort();
  assert.deepEqual(kinds, ["same-remote-origin", "same-repository"]);
  const repository = suggestion.reasons.find(
    (reason) => reason.kind === "same-repository",
  )!;
  assert.equal(
    repository.value,
    "github.com/makenotion/notion-mcp-server",
    "a repository is compared as host/owner/repository, not as a full URL",
  );
  const remote = suggestion.reasons.find(
    (reason) => reason.kind === "same-remote-origin",
  )!;
  assert.equal(remote.value, "https://mcp.notion.com");
  assert.deepEqual(remote.members, [0, 1]);
  // Each member keeps its own identity; nothing is rewritten or merged.
  assert.deepEqual(
    suggestion.members.map((member) => member.nativeId),
    ["notion/notion-mcp", "Notion", "notion"],
  );
  assert.ok(
    suggestion.limitations.some((text) => text.includes("merges nothing")),
  );
});

test("two listings sharing only a display name are never suggested", () => {
  const first = item({
    ecosystem: "smithery",
    nativeId: "acme/notes",
    displayName: "Notes",
    provenance: {
      repositoryUrl: "https://github.com/acme/notes",
      remoteUrl: "https://mcp.acme.example/mcp",
    },
  });
  const second = item({
    ecosystem: "pulsemcp",
    nativeId: "Notes",
    displayName: "Notes",
    provenance: {
      repositoryUrl: "https://github.com/globex/notes",
      remoteUrl: "https://mcp.globex.example/mcp",
    },
  });
  const third = item({
    ecosystem: "docker-mcp",
    nativeId: "notes",
    displayName: "Notes",
    description: "Notes for teams.",
  });
  assert.deepEqual(suggestEquivalences([first, second, third]), []);
});

test("a shared qualified name across sources is a medium-confidence suggestion", () => {
  const smithery = item({
    ecosystem: "smithery",
    nativeId: "acme/search-mcp",
    provenance: { qualifiedName: "acme/search-mcp" },
  });
  const registry = item({
    ecosystem: "mcp-registry",
    nativeId: "acme/search-mcp",
  });
  const suggestions = suggestEquivalences([smithery, registry]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.confidence, "medium");
  assert.deepEqual(
    suggestions[0]?.reasons.map((reason) => reason.kind),
    ["same-qualified-name"],
  );
});

test("a shared remote origin alone is low confidence and stays a suggestion", () => {
  const a = item({
    ecosystem: "pulsemcp",
    nativeId: "Gateway A",
    provenance: { remoteUrl: "https://gateway.example.com/a/mcp" },
  });
  const b = item({
    ecosystem: "smithery",
    nativeId: "vendor/gateway-b",
    provenance: { remoteUrl: "https://gateway.example.com/b/mcp" },
  });
  const suggestions = suggestEquivalences([a, b]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.confidence, "low");
  assert.ok(
    suggestions[0]?.limitations.some((text) =>
      text.includes("different deployments"),
    ),
    "a shared host is exactly the case a reviewer must judge",
  );
});

test("duplicates inside one source are not suggested unless asked for", () => {
  const first = item({
    ecosystem: "pulsemcp",
    nativeId: "Notion",
    provenance: { repositoryUrl: "https://github.com/makenotion/notion-mcp-server" },
  });
  const second = item({
    ecosystem: "pulsemcp",
    nativeId: "Notion (beta)",
    provenance: { repositoryUrl: "https://github.com/makenotion/notion-mcp-server" },
  });
  assert.deepEqual(suggestEquivalences([first, second]), []);
  const included = suggestEquivalences([first, second], {
    includeSameEcosystem: true,
  });
  assert.equal(included.length, 1);
  assert.equal(included[0]?.members.length, 2);
});

test("unusable provenance produces no suggestion", () => {
  const items = [
    item({
      ecosystem: "smithery",
      nativeId: "acme/one",
      provenance: {
        repositoryUrl: "https://github.com/acme",
        remoteUrl: "not a url",
      },
    }),
    item({
      ecosystem: "pulsemcp",
      nativeId: "One",
      provenance: {
        repositoryUrl: "javascript:alert(1)",
        remoteUrl: "http://localhost:3000/mcp",
      },
    }),
    item({ ecosystem: "docker-mcp", nativeId: "one" }),
  ];
  assert.deepEqual(suggestEquivalences(items), []);
});

test("a suggestion carries only identity, reasons and limitations", () => {
  const suggestions = suggestEquivalences([smitheryNotion, pulseNotion]);
  const suggestion = suggestions[0]!;
  assert.deepEqual(Object.keys(suggestion).sort(), [
    "confidence",
    "limitations",
    "members",
    "reasons",
  ]);
  for (const member of suggestion.members)
    assert.deepEqual(Object.keys(member).sort(), [
      "authorityNamespace",
      "displayName",
      "ecosystem",
      "index",
      "nativeId",
      "nativeVersion",
    ]);
  for (const reason of suggestion.reasons)
    assert.deepEqual(Object.keys(reason).sort(), ["kind", "members", "value"]);
  // Nothing that could stand in for authority travels in a suggestion.
  const payload = JSON.stringify({
    members: suggestion.members,
    reasons: suggestion.reasons,
    confidence: suggestion.confidence,
  }).toLowerCase();
  for (const forbidden of [
    "credential",
    "connectionref",
    "bindingref",
    "token",
    "custody",
    "verified",
    "evidence",
  ])
    assert.ok(!payload.includes(forbidden), forbidden);
});

test("the suggestion count is bounded", () => {
  const many = Array.from({ length: 20 }, (_, index) => [
    item({
      ecosystem: "smithery",
      nativeId: `acme/server-${index}`,
      provenance: { repositoryUrl: `https://github.com/acme/server-${index}` },
    }),
    item({
      ecosystem: "pulsemcp",
      nativeId: `Server ${index}`,
      provenance: { repositoryUrl: `https://github.com/acme/server-${index}` },
    }),
  ]).flat();
  assert.equal(suggestEquivalences(many).length, 20);
  assert.equal(suggestEquivalences(many, { maxSuggestions: 5 }).length, 5);
});
