import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  readDockerMcpCatalog,
  parseImageReference,
  serverExecutionBlocked,
  unsafeEnvironmentNames,
  type DockerCatalogServer,
} from "../../../src/server/connectors/registries/docker/catalog.js";

/*
 * The catalog reader is exercised against hand-written fixture files in the
 * documented Docker catalog format. The fixtures are the contract: they were
 * authored from Docker's documentation and from the shape of the served
 * catalog, never produced by this code.
 */

const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`../fixtures/docker-mcp/${name}`, import.meta.url)),
    "utf8",
  );

function serverOf(
  servers: DockerCatalogServer[],
  id: string,
): DockerCatalogServer {
  const found = servers.find((server) => server.id === id);
  assert.ok(found, `expected server ${id}`);
  return found;
}

test("reads the documented catalog format with images, secrets, env and tools", async () => {
  const { catalog, issues } = readDockerMcpCatalog(await fixture("catalog.yaml"));
  assert.ok(catalog);
  assert.equal(catalog.name, "ceremony-fixture");
  assert.equal(catalog.displayName, "Ceremony Fixture Catalog");
  assert.equal(catalog.version, "2");
  assert.deepEqual(
    catalog.servers.map((server) => server.id).sort(),
    [
      "brave",
      "context7",
      "couchbase",
      "curl",
      "desktop-commander",
      "github-official",
      "unpinned-tag",
    ],
  );
  const brave = serverOf(catalog.servers, "brave");
  assert.equal(brave.type, "server");
  assert.equal(brave.title, "Brave Search");
  assert.equal(
    brave.image?.digest,
    "sha256:f58a5c22c1196ec7bd1ca586ce216f2334fc298550ddcf652c0e8adb6d256d78",
  );
  assert.equal(brave.image?.repository, "mcp/brave-search");
  assert.deepEqual(brave.tools.map((tool) => tool.name), [
    "brave_image_search",
    "brave_news_search",
    "brave_web_search",
  ]);
  assert.deepEqual(brave.secrets, [
    {
      name: "brave.api_key",
      env: "BRAVE_API_KEY",
      example: "YOUR_API_KEY_HERE",
      description: "See Getting an API key in the upstream README.",
    },
  ]);
  assert.deepEqual(brave.env, [
    { name: "BRAVE_MCP_TRANSPORT", value: "stdio" },
  ]);
  assert.equal(brave.metadata?.category, "search");
  assert.equal(brave.metadata?.license, "MIT License");
  assert.equal(brave.dateAdded, "2025-05-05T20:08:35Z");
  assert.equal(serverExecutionBlocked(brave), false);
  // A reader that dropped unknown structures silently would hide them; the
  // catalog's own vocabulary is known, so nothing is reported here.
  assert.deepEqual(brave.unknownKeys, []);
  assert.equal(issues.some((issue) => issue.severity === "blocking"), false);
});

test("preserves config schemas, remote transports, oauth providers and poci tools", async () => {
  const { catalog } = readDockerMcpCatalog(await fixture("catalog.yaml"));
  assert.ok(catalog);
  const couchbase = serverOf(catalog.servers, "couchbase");
  assert.equal(couchbase.config.length, 1);
  assert.equal(couchbase.config[0]?.name, "couchbase");
  assert.deepEqual(
    (couchbase.config[0]?.schema as { required?: string[] }).required,
    ["cb_connection_string"],
  );
  assert.deepEqual(
    couchbase.env.map((entry) => entry.value),
    ["{{couchbase.cb_connection_string}}", "{{couchbase.cb_username}}"],
  );
  const context7 = serverOf(catalog.servers, "context7");
  assert.equal(context7.type, "remote");
  assert.equal(context7.remote?.url, "https://mcp.context7.com/mcp");
  assert.equal(context7.remote?.transportType, "streamable-http");
  assert.deepEqual(context7.remote?.headers, {
    CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}",
  });
  assert.equal(context7.image, undefined);
  const github = serverOf(catalog.servers, "github-official");
  assert.deepEqual(github.oauth?.providers, [
    {
      provider: "github",
      secret: "github.personal_access_token",
      env: "GITHUB_PERSONAL_ACCESS_TOKEN",
    },
  ]);
  assert.deepEqual(github.allowHosts, [
    "api.github.com:443",
    "github.com:443",
    "raw.githubusercontent.com:443",
  ]);
  const curl = serverOf(catalog.servers, "curl");
  assert.equal(curl.type, "poci");
  assert.equal(curl.tools[0]?.name, "curl");
  assert.equal(
    curl.tools[0]?.container?.image?.digest,
    "sha256:d7720f8cffb47e7a80d01fb2c1b38562fab0e436948537e9b77dc312d29d12d6",
  );
  assert.deepEqual(curl.tools[0]?.container?.command, ["{{args|into}}"]);
  const commander = serverOf(catalog.servers, "desktop-commander");
  assert.equal(commander.longLived, true);
  assert.deepEqual(commander.volumes, [
    "{{desktop-commander.paths|volume|into}}",
  ]);
});

test("reports an unpinned image without blocking the entry", async () => {
  const { catalog } = readDockerMcpCatalog(await fixture("catalog.yaml"));
  const unpinned = serverOf(catalog!.servers, "unpinned-tag");
  assert.equal(unpinned.image?.tag, "latest");
  assert.equal(unpinned.image?.digest, undefined);
  const issue = unpinned.issues.find(
    (item) => item.code === "docker-mcp.image.unpinned",
  );
  assert.ok(issue);
  assert.equal(issue.severity, "info");
  assert.equal(serverExecutionBlocked(unpinned), false);
});

test("forged identifiers, unsafe variables and literal credentials are refused, and valid entries survive", async () => {
  const { catalog, issues } = readDockerMcpCatalog(await fixture("hostile.yaml"));
  assert.ok(catalog);
  const ids = catalog.servers.map((server) => server.id);
  assert.ok(!ids.includes("../../etc/passwd"));
  assert.ok(!ids.includes("shell-image"));
  assert.ok(!ids.includes("unknown-type"));
  assert.ok(ids.includes("survivor"));
  assert.ok(
    issues.some(
      (issue) =>
        issue.code === "docker-mcp.server.id-invalid" &&
        issue.severity === "blocking",
    ),
  );
  assert.ok(
    issues.some((issue) => issue.code === "docker-mcp.image.invalid"),
    "a shell-injected image reference is rejected",
  );
  assert.ok(
    issues.some((issue) => issue.code === "docker-mcp.server.type-unknown"),
  );

  const loader = serverOf(catalog.servers, "loader-hijack");
  assert.deepEqual(
    loader.env.map((entry) => entry.name),
    ["SAFE_MODE"],
    "loader-altering environment names never reach the description",
  );
  assert.deepEqual(loader.secrets, []);
  assert.ok(
    loader.issues.filter((issue) => issue.code === "docker-mcp.env.unsafe-name")
      .length >= 2,
  );
  assert.equal(serverExecutionBlocked(loader), true);

  const literal = serverOf(catalog.servers, "literal-credentials");
  const serialized = JSON.stringify(literal);
  assert.ok(!serialized.includes("ghp_CANARYTOKEN4b2"));
  assert.ok(!serialized.includes("sk_live_CANARY_SECRET_9f3"));
  assert.ok(
    literal.issues.some(
      (issue) => issue.code === "docker-mcp.secret.literal-value",
    ),
  );
  assert.ok(literal.redactions.length >= 2);
  assert.equal(serverExecutionBlocked(literal), true);

  const mount = serverOf(catalog.servers, "host-mount");
  assert.equal(
    mount.issues.filter((issue) => issue.code === "docker-mcp.volume.host-path")
      .length,
    2,
  );
});

test("remote entries cannot smuggle credentials, plaintext hosts or userinfo", async () => {
  const { catalog } = readDockerMcpCatalog(await fixture("hostile.yaml"));
  assert.ok(catalog);
  const plaintext = serverOf(catalog.servers, "remote-plaintext");
  assert.equal(plaintext.remote, undefined);
  assert.ok(
    plaintext.issues.some(
      (issue) =>
        issue.code === "docker-mcp.remote.url-insecure" &&
        issue.severity === "blocking",
    ),
  );
  const userinfo = serverOf(catalog.servers, "remote-userinfo");
  assert.equal(userinfo.remote, undefined);
  assert.ok(!JSON.stringify(userinfo).includes("CANARY_PASS_7c1"));
  const header = serverOf(catalog.servers, "remote-header-canary");
  assert.deepEqual(header.remote?.headers, { "X-Trace": "enabled" });
  assert.ok(!JSON.stringify(header).includes("CANARY_SECRET_9f3"));
  assert.ok(
    header.issues.some(
      (issue) => issue.code === "docker-mcp.remote.header-literal-credential",
    ),
  );
});

test("duplicate keys, unsupported tags, alias expansion and multi-document files are refused", async () => {
  for (const [name, code] of [
    ["duplicate-keys.yaml", "docker-mcp.catalog.yaml-invalid"],
    ["unsupported-tag.yaml", "docker-mcp.catalog.yaml-unsupported-tag"],
    ["multi-document.yaml", "docker-mcp.catalog.document-count"],
  ] as const) {
    const result = readDockerMcpCatalog(await fixture(name));
    assert.equal(result.catalog, undefined, name);
    assert.equal(result.issues[0]?.code, code, name);
    assert.equal(result.issues[0]?.severity, "blocking", name);
  }
  const aliases = readDockerMcpCatalog(await fixture("alias-bomb.yaml"), {
    limits: { aliases: 4 },
  });
  assert.equal(aliases.catalog, undefined);
  assert.equal(aliases.issues[0]?.code, "docker-mcp.catalog.yaml-aliases");
});

test("prototype-polluting keys are refused and never mutate a runtime object", async () => {
  const whole = readDockerMcpCatalog(await fixture("reserved-key.yaml"));
  assert.equal(whole.catalog, undefined, "a reserved key refuses the document");
  assert.equal(whole.issues[0]?.code, "docker-mcp.catalog.reserved-key");
  const result = readDockerMcpCatalog(
    "version: 2\nname: pollution\nregistry:\n  a:\n    type: server\n    image: mcp/a@sha256:" +
      "1".repeat(64) +
      "\n    metadata:\n      __proto__:\n        polluted: true\n",
  );
  assert.equal(result.catalog, undefined);
  assert.equal(result.issues[0]?.code, "docker-mcp.catalog.reserved-key");
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    "no runtime object was mutated",
  );
});

test("catalog bounds are enforced before interpretation", () => {
  const deep = readDockerMcpCatalog(
    "version: 2\nname: deep\nregistry:\n" +
      Array.from({ length: 40 }, (_, index) => `${" ".repeat(index + 2)}k:`).join(
        "\n",
      ) +
      " v\n",
  );
  assert.equal(deep.catalog, undefined);
  assert.ok(deep.issues[0]?.code.startsWith("docker-mcp.catalog."));
  const big = readDockerMcpCatalog("version: 2\nname: big\nregistry: {}\n", {
    limits: { bytes: 4 },
  });
  assert.equal(big.issues[0]?.code, "docker-mcp.catalog.too-large");
});

test("image references are parsed in Docker's grammar, not normalized into one", () => {
  assert.deepEqual(parseImageReference("mcp/brave-search:1.2.3"), {
    raw: "mcp/brave-search:1.2.3",
    repository: "mcp/brave-search",
    tag: "1.2.3",
  });
  const pinned = parseImageReference(
    `ghcr.io/github/github-mcp-server@sha256:${"a".repeat(64)}`,
  );
  assert.equal(pinned?.registry, "ghcr.io");
  assert.equal(pinned?.repository, "github/github-mcp-server");
  assert.equal(pinned?.digest, `sha256:${"a".repeat(64)}`);
  for (const bad of [
    "mcp/evil:latest; rm -rf /",
    "mcp/evil latest",
    "MCP/Upper:1",
    "mcp/evil@md5:abc",
    "mcp/evil@sha256:short",
    "../../mcp/evil",
  ])
    assert.equal(parseImageReference(bad), undefined, bad);
});

test("the unsafe environment list covers loader and program-lookup variables", () => {
  for (const name of [
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "PATH",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "BASH_ENV",
    "GIT_SSH_COMMAND",
    "DOCKER_HOST",
  ])
    assert.ok(unsafeEnvironmentNames.has(name), name);
});
