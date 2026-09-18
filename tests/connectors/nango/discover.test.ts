import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  NANGO_CONFIGURATION_NAMES,
  nangoSnapshotSchema,
  serviceSlug,
} from "../../../src/server/connectors/providers/nango/index.js";
import {
  capabilityFor,
  ENVIRONMENT,
  harness,
  INTEGRATION,
  sampleFunctions,
  SECRET_KEY,
} from "./harness.js";

/*
 * NG-01 integration discovery and AC-NG-08 metadata import without YAML.
 * The double asserts the documented request contract; these tests assert the
 * identities, pagination and diagnostics the adapter derives from it.
 */

test("NG-01: discovery preserves environment and unique_key identity, not the provider slug", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const result = await h.adapter.discover!(h.context(), {});

  assert.equal(result.items.length, 3);
  const [first, second] = result.items;
  // Two integrations share the provider "github" and the display name
  // "GitHub"; they are different configurations and must not collide.
  assert.equal(first!.identity.nativeId, INTEGRATION);
  assert.equal(second!.identity.nativeId, "github-sandbox");
  assert.notEqual(first!.identity.nativeId, second!.identity.nativeId);
  assert.equal(first!.provenance?.provider, "github");
  assert.equal(second!.provenance?.provider, "github");
  // The environment and API origin are part of the authority namespace, so
  // the same unique_key in another environment is a different identity.
  assert.equal(
    first!.identity.authorityNamespace,
    `${ENVIRONMENT}@${h.double.origin}`,
  );
  assert.equal(first!.identity.nativeVersion, "2026-02-03T04:05:06.000Z");
  assert.equal(result.freshness.source, "live");
  assert.equal(result.freshness.stale, false);

  const listed = h.double.received("GET", "/integrations");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.headers.authorization, `Bearer ${SECRET_KEY}`);
});

test("NG-01: per-integration discovery returns auth configuration and native capability metadata", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const result = await h.adapter.discover!(h.context(), {
    scope: { integration: INTEGRATION },
  });

  const integration = result.items.find((item) => item.provenance?.kind === "integration");
  assert.ok(integration);
  assert.equal(integration.provenance?.forwardWebhooks, "true");

  const sync = result.items.find((item) => item.provenance?.type === "sync");
  const action = result.items.find((item) => item.provenance?.type === "action");
  const onEvent = result.items.find((item) => item.provenance?.type === "on-event");
  assert.equal(sync?.identity.nativeId, `${INTEGRATION}/functions/sync/github-issues`);
  assert.equal(sync?.provenance?.runs, "every hour");
  assert.equal(action?.identity.nativeId, `${INTEGRATION}/functions/action/create-issue`);
  // A deployed-but-disabled function stays visible and is marked, not hidden.
  assert.equal(onEvent?.status, "deprecated");
  assert.equal(onEvent?.provenance?.event, "validate-connection");
});

test("NG-01: discovery paginates functions with an opaque cursor bound to its integration", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const first = await h.adapter.discover!(h.context(), {
    scope: { integration: INTEGRATION },
    limit: 2,
  });
  assert.ok(first.nextCursor);
  // Page 0 carries the integration row plus `limit` functions.
  assert.equal(first.items.length, 3);

  const second = await h.adapter.discover!(h.context(), { cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]!.provenance?.type, "on-event");
  assert.equal(second.nextCursor, undefined);

  await assert.rejects(
    h.adapter.discover!(h.context(), {
      cursor: first.nextCursor,
      scope: { integration: "slack-community" },
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.discover.cursor",
  );
  await assert.rejects(
    h.adapter.discover!(h.context(), { cursor: "not-a-cursor" }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.discover.cursor",
  );
});

test("NG-01: discovery never asks for integration credentials", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await h.adapter.discover!(h.context(), { scope: { integration: INTEGRATION } });
  await h.adapter.captureIntegration(h.context(), INTEGRATION);

  for (const request of h.double.requests) {
    assert.ok(
      !request.url.searchParams.getAll("include").includes("credentials"),
      `request to ${request.url.pathname} asked for credentials`,
    );
  }
});

test("AC-NG-08: current integration and function metadata import without a nango.yaml parser", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const captured = await h.adapter.captureIntegration(h.context(), INTEGRATION);
  const snapshot = nangoSnapshotSchema.parse(
    JSON.parse(new TextDecoder().decode(captured.bytes)),
  );
  assert.equal(snapshot.integration.unique_key, INTEGRATION);
  assert.equal(snapshot.functions.length, sampleFunctions[INTEGRATION].length);

  const outcome = await h.adapter.import!(h.context(), captured);
  const definition = outcome.definitions[0];
  assert.ok(definition);
  assert.equal(definition.identity.nativeId, INTEGRATION);
  assert.equal(definition.display.service, "github");

  const sync = definition.capabilities.find((item) => item.kind === "sync");
  const action = definition.capabilities.find((item) => item.kind === "action");
  assert.equal(sync?.nativeId, "github-issues");
  assert.equal(sync?.effect, "read");
  assert.equal(sync?.nativeExtensions?.runs, "every hour");
  assert.equal(action?.nativeId, "create-issue");
  // An action's effect is not guessed from its name.
  assert.equal(action?.effect, "unknown");

  // Both broker custody modes are described, and neither is a fabricated
  // credential method for an API that has none of its own here.
  const kinds = definition.authentication.map((profile) => profile.kind);
  assert.deepEqual(kinds, ["external-broker", "external-broker"]);
  assert.deepEqual(
    definition.events.map((event) => event.nativeId).sort(),
    ["auth", "forward", "sync"],
  );
  assert.deepEqual(
    outcome.executableCandidates.sort(),
    ["create-issue", "github-issues"],
  );
  assert.ok(
    outcome.issues.some((issue) => issue.code === "nango.function.disabled"),
    "a disabled function is reported",
  );
  assert.equal(
    definition.configuration.find((item) => item.name === NANGO_CONFIGURATION_NAMES.secretKey)
      ?.classification,
    "secret",
  );
});

test("AC-NG-08: a legacy nango.yaml is refused with a blocking diagnostic, never parsed", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const yaml = [
    "integrations:",
    "  github:",
    "    issues:",
    "      runs: every 1h",
    "      sync_type: full",
    "models:",
    "  GithubIssue:",
    "    id: string",
  ].join("\n");
  const outcome = await h.adapter.import!(h.context(), {
    bytes: new TextEncoder().encode(yaml),
    mediaType: "application/yaml",
    origin: { kind: "upload" },
  });

  assert.equal(outcome.definitions.length, 0);
  assert.equal(outcome.executableCandidates.length, 0);
  const issue = outcome.issues[0];
  assert.equal(issue?.code, "nango.yaml.legacy-unsupported");
  assert.equal(issue?.severity, "blocking");
  assert.equal(issue?.executionImpact, "blocks-definition");
  // The source record still preserves the bytes' provenance.
  assert.equal(outcome.source.format.name, "nango-yaml");
  assert.match(outcome.source.digest.value, /^[a-f0-9]{64}$/);
});

test("NG-01: the directory shows one entry per integration, grouped but not merged", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const present = new Set([
    NANGO_CONFIGURATION_NAMES.secretKey,
    NANGO_CONFIGURATION_NAMES.environment,
  ]);
  const entries = await h.adapter.catalogEntries(h.context(), present);

  assert.equal(entries.length, 3);
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, 3, "two GitHub integrations get distinct rows");
  const github = entries.filter((entry) => entry.service === "github");
  assert.equal(github.length, 2);
  assert.deepEqual([...new Set(github.map((entry) => entry.group))], ["github"]);
  assert.equal(entries.every((entry) => entry.support === "provider-backed"), true);
  assert.deepEqual(entries[0]!.authentication, ["external-broker"]);
  // No entry carries a destination, token or configuration value.
  assert.equal(
    entries.every((entry) =>
      entry.configuration.every((item) => Object.keys(item).sort().join(",") ===
        "classification,name,present,required"),
    ),
    true,
  );
});

test("NG-01: missing required configuration reports unconfigured, not unsupported", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const entries = await h.adapter.catalogEntries(h.context(), new Set());
  assert.equal(entries.every((entry) => entry.support === "unconfigured"), true);

  const discover = capabilityFor(h.adapter, "discover", []);
  assert.equal(discover?.implementation, "implemented");
  assert.equal(discover?.configuration, "missing");

  const ready = capabilityFor(h.adapter, "discover", [
    NANGO_CONFIGURATION_NAMES.secretKey,
    NANGO_CONFIGURATION_NAMES.environment,
  ]);
  assert.equal(ready?.configuration, "ready");

  // Native limits are reported rather than implied.
  const revoke = capabilityFor(h.adapter, "revoke", [
    NANGO_CONFIGURATION_NAMES.secretKey,
    NANGO_CONFIGURATION_NAMES.environment,
  ]);
  assert.equal(revoke?.implementation, "unsupported");
  assert.equal(revoke?.evidence, "not-tested");
});

test("NG-01: a self-hosted NANGO_HOST disagreeing with the approved destination is refused", async (t) => {
  const h = await harness({
    configuration: { [NANGO_CONFIGURATION_NAMES.host]: "https://nango.example.test" },
  });
  t.after(() => h.close());
  await assert.rejects(
    h.adapter.discover!(h.context(), {}),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "nango.destination.host-mismatch",
  );
  assert.equal(h.double.requests.length, 0);
});

test("NG-01: a missing or malformed environment blocks every call before a request", async (t) => {
  const h = await harness({
    configuration: { [NANGO_CONFIGURATION_NAMES.environment]: "PROD ENV" },
  });
  t.after(() => h.close());
  await assert.rejects(
    h.adapter.discover!(h.context(), {}),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "nango.configuration.environment",
  );
  assert.equal(h.double.requests.length, 0);
});

test("NG-01: provider slugs become directory service keys without becoming identities", () => {
  assert.equal(serviceSlug("github"), "github");
  assert.equal(serviceSlug("Google Calendar"), "google-calendar");
  assert.equal(serviceSlug("///"), "nango");
});
