import assert from "node:assert/strict";
import test from "node:test";
import {
  parseImageReference,
  readDockerMcpCatalog,
  serverExecutionBlocked,
  type DockerCatalogReadResult,
  type DockerCatalogServer,
} from "../../../src/server/connectors/registries/docker/catalog.js";

/*
 * What the Docker MCP catalog reader *refuses*, and whether it refuses for the
 * stated reason. The reader's whole claim is that reading a catalog installs,
 * mounts and executes nothing, and that what it reports is what the document
 * says — no more. These tests therefore push malformed, oversized, duplicated
 * and hostile documents at it and assert on the diagnostic, the pointer and
 * the surviving description, never merely that "it did not crash".
 *
 * Documents are written inline here rather than as fixtures: each one exists
 * to isolate a single refusal, and keeping the YAML beside the assertion is
 * what makes the refusal auditable. The well-formed, documented shape of the
 * format is covered by the fixture-driven tests in catalog.test.ts.
 */

const PINNED = `mcp/fixture@sha256:${"b".repeat(64)}`;

/** One-server catalog; `entry` is the YAML body under registry/fixture, indented four spaces. */
function catalogOf(entry: string): string {
  return `version: 2\nname: bounds\nregistry:\n  fixture:\n${entry}`;
}

function readEntry(
  entry: string,
  options: Parameters<typeof readDockerMcpCatalog>[1] = {},
): { result: DockerCatalogReadResult; server: DockerCatalogServer } {
  const result = readDockerMcpCatalog(catalogOf(entry), options);
  assert.ok(result.catalog, "expected the document to yield a catalog");
  const server = result.catalog.servers.find((item) => item.id === "fixture");
  assert.ok(server, "expected the fixture entry to be imported");
  return { result, server };
}

const codesOf = (issues: readonly { code: string }[]) =>
  issues.map((issue) => issue.code);

function issueAt(
  server: DockerCatalogServer,
  code: string,
): DockerCatalogServer["issues"][number] {
  const found = server.issues.find((issue) => issue.code === code);
  assert.ok(found, `expected issue ${code}, saw ${codesOf(server.issues)}`);
  return found;
}

test("an entry that declares nothing optional is described as declaring nothing", () => {
  // Invariant: an absent field reads as absent. A reader that filled in `{}`
  // for metadata, `{providers: []}` for oauth or a placeholder remote would
  // make every catalog look equally well-described, which is the one thing a
  // compatibility report must never do: it would hide that the upstream
  // document says nothing about network reach, credentials or tooling.
  const { server } = readEntry(`    type: server\n    image: ${PINNED}\n`);
  assert.deepEqual(server.issues, [], "a complete minimal entry is unremarked");
  assert.deepEqual(
    {
      tools: server.tools,
      secrets: server.secrets,
      env: server.env,
      command: server.command,
      volumes: server.volumes,
      allowHosts: server.allowHosts,
      config: server.config,
      unknownKeys: server.unknownKeys,
      redactions: server.redactions,
    },
    {
      tools: [],
      secrets: [],
      env: [],
      command: [],
      volumes: [],
      allowHosts: [],
      config: [],
      unknownKeys: [],
      redactions: [],
    },
  );
  for (const absent of [
    server.metadata,
    server.oauth,
    server.remote,
    server.prompts,
    server.title,
    server.description,
    server.dateAdded,
    server.ref,
    server.readme,
    server.resources,
  ])
    assert.equal(absent, undefined);
  assert.equal(server.image?.digest, `sha256:${"b".repeat(64)}`);
  assert.equal(serverExecutionBlocked(server), false);
});

test("a field of the wrong shape is refused where it stands, and the entry survives", () => {
  // Invariant: a malformed sub-field is refused at its own pointer and the
  // rest of the entry is still described. The alternative — dropping the
  // whole entry, or coercing "not a list" into a one-item list of characters
  // — either loses evidence or invents it.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    tools: "not a list"\n` +
      `    secrets: "not a list"\n` +
      `    env: "not a list"\n` +
      `    metadata: "not an object"\n` +
      `    oauth: 7\n`,
  );
  assert.deepEqual(
    codesOf(server.issues).sort(),
    [
      "docker-mcp.env.not-a-list",
      "docker-mcp.metadata.invalid",
      "docker-mcp.oauth.invalid",
      "docker-mcp.secrets.not-a-list",
      "docker-mcp.tools.not-a-list",
    ],
    "every malformed field is named once, at its own pointer",
  );
  assert.equal(
    issueAt(server, "docker-mcp.tools.not-a-list").sourcePointer,
    "/registry/fixture/tools",
  );
  assert.deepEqual([server.tools, server.secrets, server.env], [[], [], []]);
  assert.equal(server.metadata, undefined);
  assert.equal(server.oauth, undefined);
  // None of this stops a runner: the entry is thinner than declared, not unsafe.
  assert.equal(serverExecutionBlocked(server), false);
});

test("a config object written bare is read as a one-item list and said so", () => {
  // Invariant: the served catalog writes `config` both as a list and as a
  // single mapping. Accepting both is fine; doing it silently is not, because
  // a reader comparing two catalogs would see a shape difference that never
  // appears in the report.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    config:\n` +
      `      name: fixture\n` +
      `      description: One bare config object.\n` +
      `      properties:\n` +
      `        token: {type: string}\n`,
  );
  const single = issueAt(server, "docker-mcp.config.single-object");
  assert.equal(single.severity, "info");
  assert.equal(server.config.length, 1);
  assert.equal(server.config[0]?.name, "fixture");
  assert.equal(server.config[0]?.description, "One bare config object.");
  // name and description are lifted out of the schema, not duplicated into it.
  assert.deepEqual(server.config[0]?.schema, {
    properties: { token: { type: "string" } },
  });
});

test("a config entry that is not an object, or names nothing safely, is dropped", () => {
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    config:\n` +
      `      - "a string"\n` +
      `      - name: "../escape"\n` +
      `      - name: fixture\n` +
      `        properties:\n` +
      `          "bad name": {type: string}\n` +
      `          "9bad": {type: string}\n` +
      `          good_name: {type: string}\n`,
  );
  // Invariant: a config *name* becomes a configuration key downstream and a
  // config *property* becomes a key in a generated object; both must be safe
  // identifiers. Dropping an unsafe one quietly would let a catalog choose a
  // key the host never intended. (A literal `__proto__` key never reaches
  // here: it refuses the whole document at the measuring step, which
  // catalog.test.ts already pins.)
  assert.equal(server.config.length, 1);
  assert.equal(server.config[0]?.name, "fixture");
  assert.deepEqual(server.config[0]?.schema, {
    properties: { good_name: { type: "string" } },
  });
  assert.deepEqual(codesOf(server.issues).sort(), [
    "docker-mcp.config.invalid",
    "docker-mcp.config.name-invalid",
    "docker-mcp.config.property-invalid",
    "docker-mcp.config.property-invalid",
  ]);
  assert.equal(
    issueAt(server, "docker-mcp.config.property-invalid").disposition,
    "rejected",
    "a dropped property is reported as rejected, not as adapted",
  );
  assert.equal(
    ({} as Record<string, unknown>)["polluted"],
    undefined,
    "no runtime object was mutated while reading",
  );
});

test("an entry missing a required field is dropped whole rather than half-described", () => {
  // Invariant: a half-read entry is worse than no entry. A containerized
  // server with no image, a registry value that is not a mapping, and a
  // remote entry with no remote object are all unusable, so none of them may
  // appear in `servers` as if it were importable.
  const scalar = readDockerMcpCatalog(
    'version: 2\nname: bounds\nregistry:\n  fixture: "a string"\n',
  );
  assert.deepEqual(scalar.catalog?.servers, []);
  assert.equal(scalar.issues[0]?.code, "docker-mcp.server.invalid");
  assert.equal(scalar.issues[0]?.severity, "blocking");

  const imageless = readDockerMcpCatalog(
    "version: 2\nname: bounds\nregistry:\n  fixture:\n    type: server\n",
  );
  assert.deepEqual(imageless.catalog?.servers, []);
  assert.equal(imageless.issues[0]?.code, "docker-mcp.image.missing");
  assert.equal(imageless.issues[0]?.sourcePointer, "/registry/fixture/image");

  // An empty image string is the same as none: it must not parse as a repository.
  const empty = readDockerMcpCatalog(
    'version: 2\nname: bounds\nregistry:\n  fixture:\n    type: server\n    image: ""\n',
  );
  assert.equal(empty.issues[0]?.code, "docker-mcp.image.missing");

  // A remote-typed entry keeps its identity but cannot be reached.
  const { server: remoteless } = readEntry(`    type: remote\n`);
  assert.equal(remoteless.remote, undefined);
  assert.equal(
    issueAt(remoteless, "docker-mcp.remote.missing").executionImpact,
    "blocks-operation",
  );
  assert.equal(serverExecutionBlocked(remoteless), true);
});

test("a name declared twice keeps the first definition and reports the second", () => {
  // Invariant: a catalog must not present two different definitions under one
  // name. Last-write-wins would let an appended entry redefine a tool, a
  // secret or an environment variable that a reviewer had already approved,
  // so the first definition stands and the collision is reported.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    tools:\n` +
      `      - name: alpha\n` +
      `        description: first\n` +
      `      - name: alpha\n` +
      `        description: second\n` +
      `    secrets:\n` +
      `      - name: fixture.key\n` +
      `        env: FIRST_ENV\n` +
      `      - name: fixture.key\n` +
      `        env: SECOND_ENV\n` +
      `    env:\n` +
      `      - name: MODE\n` +
      `        value: first\n` +
      `      - name: MODE\n` +
      `        value: second\n`,
  );
  assert.deepEqual(
    server.tools.map((tool) => tool.description),
    ["first"],
  );
  assert.deepEqual(
    server.secrets.map((secret) => secret.env),
    ["FIRST_ENV"],
  );
  assert.deepEqual(server.env, [{ name: "MODE", value: "first" }]);
  for (const code of [
    "docker-mcp.tool.duplicate",
    "docker-mcp.secret.duplicate",
    "docker-mcp.env.duplicate",
  ])
    assert.equal(issueAt(server, code).severity, "warning", code);
});

test("reader limits truncate a listing instead of letting a document set its own size", () => {
  // Invariant: every list has a ceiling the *reader* owns, so a catalog cannot
  // decide how much work reading it costs. The description then holds the
  // first N entries, which is a smaller truth, never a different one.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    tools:\n      - name: one\n      - name: two\n` +
      `    secrets:\n` +
      `      - {name: one, env: ONE}\n      - {name: two, env: TWO}\n` +
      `    env:\n` +
      `      - {name: ONE, value: a}\n      - {name: TWO, value: b}\n` +
      `    command: ["one", "two"]\n` +
      `    volumes: ["one", "two"]\n` +
      `    allowHosts: ["one.example", "two.example"]\n` +
      `    config:\n      - name: one\n      - name: two\n`,
    {
      limits: {
        tools: 1,
        secrets: 1,
        env: 1,
        command: 1,
        volumes: 1,
        allowHosts: 1,
        configs: 1,
      },
    },
  );
  assert.deepEqual(
    server.tools.map((tool) => tool.name),
    ["one"],
  );
  assert.deepEqual(
    server.secrets.map((secret) => secret.name),
    ["one"],
  );
  assert.deepEqual(
    server.env.map((entry) => entry.name),
    ["ONE"],
  );
  assert.deepEqual(server.command, ["one"]);
  assert.deepEqual(server.volumes, ["one"]);
  assert.deepEqual(server.allowHosts, ["one.example"]);
  assert.deepEqual(
    server.config.map((entry) => entry.name),
    ["one"],
  );
  // Only the tool list announces its own truncation today; the others
  // truncate silently, which is recorded here as the behaviour under test
  // rather than asserted as desirable.
  assert.equal(
    issueAt(server, "docker-mcp.tools.too-many").sourcePointer,
    "/registry/fixture/tools/1",
  );
});

test("every name is held to an identifier rule, not just the server id", () => {
  // Invariant: an unsafe name anywhere in an entry is refused. A tool name
  // reaches a tool registry, a secret name reaches a secret store and an env
  // name reaches a process environment; a traversal or a loader variable in
  // any of them is a way to act through the description, so each is named and
  // dropped at its own pointer.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    tools:\n      - name: "../../etc/passwd"\n      - "a bare string"\n` +
      `    secrets:\n` +
      `      - {name: "__proto__", env: SAFE_ONE}\n` +
      `      - {name: bad.env, env: "9NOT_A_NAME"}\n` +
      `      - {name: loader, env: LD_PRELOAD}\n` +
      `      - {name: fixture.ok, env: FIXTURE_OK}\n` +
      `    env:\n      - {name: "BAD-NAME", value: x}\n      - {name: PATH, value: /evil}\n`,
  );
  assert.deepEqual(server.tools, [], "no tool survives an unsafe name");
  assert.deepEqual(
    server.secrets.map((secret) => secret.name),
    ["fixture.ok"],
  );
  assert.deepEqual(server.env, [], "no environment variable survives");
  assert.deepEqual(codesOf(server.issues).sort(), [
    "docker-mcp.env.name-invalid",
    "docker-mcp.env.unsafe-name",
    "docker-mcp.env.unsafe-name",
    "docker-mcp.secret.env-invalid",
    "docker-mcp.secret.name-invalid",
    "docker-mcp.tool.invalid",
    "docker-mcp.tool.name-invalid",
  ]);
  assert.equal(
    issueAt(server, "docker-mcp.env.unsafe-name").category,
    "policy",
    "a loader variable is a policy refusal, not a spelling mistake",
  );
  assert.equal(serverExecutionBlocked(server), true);
});

test("a scalar list keeps numbers and booleans verbatim and refuses structures", () => {
  // Invariant: catalogs write ports and flags unquoted, so `8080` must read as
  // the exact text an argument would carry. A nested list or mapping, though,
  // has no single textual form, and flattening one into an argument would
  // invent the command that gets run.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    command: ["--port", 8080, true, [nested]]\n` +
      `    env:\n` +
      `      - {name: PORT, value: 8080}\n` +
      `      - {name: DEBUG, value: true}\n` +
      `      - {name: OPTS, value: {nested: true}}\n`,
  );
  assert.deepEqual(server.command, ["--port", "8080", "true"]);
  assert.deepEqual(server.env, [
    { name: "PORT", value: "8080" },
    { name: "DEBUG", value: "true" },
  ]);
  assert.equal(
    issueAt(server, "docker-mcp.env.value-invalid").sourcePointer,
    "/registry/fixture/env/2/value",
  );
});

test("a command argument carrying a control character blocks execution", () => {
  // Invariant: control characters in an argv entry are how a printed command
  // line is made to lie about itself (a carriage return hides what follows).
  // The argument is dropped and the entry is marked unrunnable rather than
  // quietly cleaned, because a cleaned command is not the declared command.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    command: ["serve", "--flag\\x07"]\n`,
  );
  assert.deepEqual(server.command, ["serve"]);
  const issue = issueAt(server, "docker-mcp.command.control-characters");
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.executionImpact, "blocks-operation");
  assert.equal(serverExecutionBlocked(server), true);
});

test("a tool container is described but never presented as runnable when its image is not an OCI reference", () => {
  // Invariant: a poci tool names an image a runner would pull. A reference
  // that is not a valid OCI reference could carry shell metacharacters into
  // whatever composes the pull command, so the tool stays described (its name
  // is evidence) while the entry is marked as blocking execution.
  const { server } = readEntry(
    `    type: poci\n` +
      `    image: ${PINNED}\n` +
      `    tools:\n` +
      `      - name: shell\n` +
      `        container:\n` +
      `          image: "mcp/evil:latest; rm -rf /"\n` +
      `          command: ["run"]\n`,
  );
  assert.equal(server.tools.length, 1);
  assert.equal(server.tools[0]?.name, "shell");
  assert.equal(
    server.tools[0]?.container?.image,
    undefined,
    "no partial or normalized reference is kept",
  );
  assert.deepEqual(server.tools[0]?.container?.command, ["run"]);
  const issue = issueAt(server, "docker-mcp.image.invalid");
  assert.equal(issue.severity, "blocking");
  assert.equal(
    issue.sourcePointer,
    "/registry/fixture/tools/0/container/image",
  );
  assert.equal(serverExecutionBlocked(server), true);
});

test("inert JSON beyond the reader's bounds is dropped, not measured after the fact", () => {
  // Invariant: tool parameters and config schemas are carried verbatim, so
  // they are the one place an unbounded document could reach a store. They
  // are measured before being copied, and an over-bound value is dropped with
  // a diagnostic instead of being truncated into a schema that means
  // something else.
  let deep = "1";
  for (let index = 0; index < 14; index += 1) deep = `{a: ${deep}}`;
  const wide = Array.from({ length: 1200 }, (_, i) => `p${i}: 1`).join(", ");
  const { server } = readEntry(
    `    type: poci\n` +
      `    image: ${PINNED}\n` +
      `    tools:\n` +
      `      - name: deep\n` +
      `        parameters: ${deep}\n` +
      `    config:\n` +
      `      - name: wide\n` +
      `        properties: {${wide}}\n`,
  );
  assert.equal(server.tools.length, 1, "the tool is still named");
  assert.equal(server.tools[0]?.parameters, undefined);
  assert.equal(
    issueAt(server, "docker-mcp.tool.parameters-unbounded").sourcePointer,
    "/registry/fixture/tools/0/parameters",
  );
  assert.deepEqual(server.config, [], "an unbounded config schema is dropped");
  assert.ok(
    server.issues.some(
      (issue) => issue.code === "docker-mcp.config.schema-unbounded",
    ),
  );
});

test("oauth providers may be written as a bare list, and an unsafe provider is refused", () => {
  // Invariant: the format appears both as `oauth: {providers: [...]}` and as a
  // bare list; both are read. But an oauth provider names the environment
  // variable a token is handed to, so a loader variable or an unspellable
  // provider is refused rather than carried into a launch.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    oauth:\n` +
      `      - {provider: github, secret: fixture.token, env: GITHUB_TOKEN}\n` +
      `      - {provider: loader, secret: fixture.token, env: LD_PRELOAD}\n` +
      `      - {provider: "not a provider!", secret: fixture.token, env: OK_ENV}\n` +
      `      - {provider: nosecret, env: OK_ENV}\n`,
  );
  assert.deepEqual(server.oauth?.providers, [
    { provider: "github", secret: "fixture.token", env: "GITHUB_TOKEN" },
  ]);
  assert.equal(
    server.issues.filter(
      (issue) => issue.code === "docker-mcp.oauth.provider-invalid",
    ).length,
    3,
  );
  assert.equal(
    issueAt(server, "docker-mcp.oauth.provider-invalid").disposition,
    "rejected",
  );
});

test("a remote entry refuses what it cannot verify about its headers", () => {
  // Invariant: a remote header is sent to a third party on every call. A name
  // that is not an HTTP token, a value that is not a scalar, and a template
  // naming a variable no declared secret provides are each reported, and only
  // the headers the document actually establishes survive.
  const { server } = readEntry(
    `    type: remote\n` +
      `    secrets:\n      - {name: fixture.key, env: FIXTURE_KEY}\n` +
      `    remote:\n` +
      `      url: https://mcp.example.com/mcp\n` +
      `      transport_type: websocket\n` +
      `      headers:\n` +
      `        "bad header": present\n` +
      `        X-Struct: {a: b}\n` +
      `        X-Bound: "\${FIXTURE_KEY}"\n` +
      `        X-Unbound: "\${MISSING_KEY}"\n` +
      `        X-Trace: enabled\n`,
  );
  assert.deepEqual(server.remote?.headers, {
    "X-Bound": "${FIXTURE_KEY}",
    "X-Unbound": "${MISSING_KEY}",
    "X-Trace": "enabled",
  });
  assert.equal(server.remote?.transportType, "websocket");
  assert.deepEqual(codesOf(server.issues).sort(), [
    "docker-mcp.remote.header-name-invalid",
    "docker-mcp.remote.header-unbound-variable",
    "docker-mcp.remote.header-value-invalid",
    "docker-mcp.remote.transport-unknown",
  ]);
  // An unknown transport is preserved as declared, not replaced by a guess.
  assert.equal(
    issueAt(server, "docker-mcp.remote.transport-unknown").severity,
    "warning",
  );
  assert.equal(serverExecutionBlocked(server), false);

  const listHeaders = readEntry(
    `    type: remote\n` +
      `    remote:\n      url: https://mcp.example.com/mcp\n      headers: ["X-Trace: enabled"]\n`,
  );
  assert.deepEqual(listHeaders.server.remote?.headers, {});
  assert.equal(
    issueAt(listHeaders.server, "docker-mcp.remote.headers-invalid").severity,
    "warning",
  );
});

test("plain HTTP is refused off the loopback interface and allowed on it", () => {
  // Invariant: the refusal is about exposure, not about the scheme in the
  // abstract. A local runner legitimately talks to 127.0.0.1 over HTTP, while
  // the same URL on a public host would send bearer headers in clear text.
  // Getting this wrong in either direction is a false report.
  const { server: local } = readEntry(
    `    type: remote\n    remote:\n      url: http://localhost:3000/mcp\n`,
  );
  assert.equal(local.remote?.url, "http://localhost:3000/mcp");
  assert.deepEqual(local.issues, []);

  const { server: loopbackIp } = readEntry(
    `    type: remote\n    remote:\n      url: http://127.0.0.1:3000/mcp\n`,
  );
  assert.equal(loopbackIp.remote?.url, "http://127.0.0.1:3000/mcp");

  const { server: exposed } = readEntry(
    `    type: remote\n    remote:\n      url: http://mcp.example.com/mcp\n`,
  );
  assert.equal(exposed.remote, undefined);
  assert.equal(
    issueAt(exposed, "docker-mcp.remote.url-insecure").category,
    "network",
  );
});

test("a declared link must be a plain http(s) URL and nothing else", () => {
  // Invariant: readme, source, icon and toolsUrl are shown to a person and
  // may be followed. A `javascript:` or `data:` scheme is not a link, a
  // fragment makes two links compare unequal for no reason, and userinfo in a
  // URL is a credential in a document that must not carry one.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    readme: "not a url"\n` +
      `    toolsUrl: 7\n` +
      `    source: "javascript:alert(1)"\n` +
      `    upstream: "https://docs.example.com/x#section"\n` +
      `    icon: "https://carrier:CANARY_PASS_7c1@icons.example.com/i.png"\n`,
  );
  for (const key of [
    "readme",
    "toolsUrl",
    "source",
    "upstream",
    "icon",
  ] as const)
    assert.equal(server[key], undefined, key);
  assert.equal(
    server.issues.filter((issue) => issue.code === "docker-mcp.link.invalid")
      .length,
    5,
  );
  assert.ok(
    !JSON.stringify(server).includes("CANARY_PASS_7c1"),
    "a credential in a link never reaches the description",
  );
});

test("a timestamp that is not RFC 3339 is ignored rather than reshaped", () => {
  // Invariant: dateAdded is ordering evidence. Accepting "2026-13-45" or a
  // bare year would let a catalog claim an age it cannot support, so an
  // unparseable value is dropped and the drop is reported.
  for (const raw of ['"2026-13-45"', '"yesterday"', "2026", '"2026-09-18"']) {
    const { server } = readEntry(
      `    type: server\n    image: ${PINNED}\n    dateAdded: ${raw}\n`,
    );
    assert.equal(server.dateAdded, undefined, raw);
    assert.equal(
      issueAt(server, "docker-mcp.server.date-invalid").sourcePointer,
      "/registry/fixture/dateAdded",
    );
  }
  const { server: valid } = readEntry(
    `    type: server\n    image: ${PINNED}\n    dateAdded: "2026-09-18T00:00:00Z"\n`,
  );
  assert.equal(valid.dateAdded, "2026-09-18T00:00:00Z");
  assert.deepEqual(valid.issues, []);
});

test("an allowHosts entry that is not a host[:port] is dropped, not widened", () => {
  // Invariant: allowHosts is the entry's declared network reach. A wildcard
  // scheme, a URL or a path would either be read as a broader permission than
  // written or silently kept as an unenforceable string; both misreport reach.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    allowHosts:\n` +
      `      - api.github.com:443\n` +
      `      - "*.example.com"\n` +
      `      - "https://api.example.com"\n` +
      `      - "api.example.com/path"\n` +
      `      - "*"\n`,
  );
  assert.deepEqual(server.allowHosts, ["api.github.com:443", "*.example.com"]);
  assert.equal(
    server.issues.filter(
      (issue) => issue.code === "docker-mcp.allow-host.invalid",
    ).length,
    3,
  );
});

test("a malformed or oversized listing is refused before any field is interpreted", () => {
  // Invariant: the document is established as a document first. A YAML fault,
  // an alias whose expansion is cheap to write and expensive to build, a root
  // that is not a mapping, an unsafe catalog name and a missing registry are
  // all refused with no catalog at all, so nothing downstream can act on a
  // partial read.
  const refusals: Array<[string, string]> = [
    ["version: 2\nname: bounds\nregistry:\n  fixture: [1, 2\n", "yaml-invalid"],
    [
      `version: 2\nname: bounds\nregistry:\n${String.fromCharCode(9)} fixture: 1\n`,
      "yaml-invalid",
    ],
    ["just a string\n", "not-an-object"],
    ['version: 2\nname: "../evil"\nregistry: {}\n', "name-invalid"],
    ["version: 2\nname: bounds\n", "registry-missing"],
    ["version: 2\nname: bounds\nregistry: []\n", "registry-missing"],
  ];
  for (const [text, suffix] of refusals) {
    const result = readDockerMcpCatalog(text);
    assert.equal(result.catalog, undefined, suffix);
    assert.equal(result.issues[0]?.code, `docker-mcp.catalog.${suffix}`, text);
    assert.equal(result.issues[0]?.severity, "blocking", text);
  }

  // Aliases whose count is within bounds but whose expansion is not: the
  // reader refuses during expansion rather than materializing the result.
  const bomb = ["version: 2", "name: bounds", "registry:"];
  bomb.push("  a0: &a0 [x, x, x, x, x, x, x, x]");
  for (let level = 1; level < 7; level += 1)
    bomb.push(
      `  a${level}: &a${level} [*a${level - 1}, *a${level - 1}, *a${level - 1}, *a${level - 1}]`,
    );
  const expansion = readDockerMcpCatalog(`${bomb.join("\n")}\n`);
  assert.equal(expansion.catalog, undefined);
  assert.equal(
    expansion.issues[0]?.code,
    "docker-mcp.catalog.yaml-expansion",
    "expansion cost is bounded, not just the number of aliases",
  );

  const tooMany = readDockerMcpCatalog(
    `version: 2\nname: bounds\nregistry:\n  one:\n    type: remote\n  two:\n    type: remote\n`,
    { limits: { servers: 1 } },
  );
  assert.equal(tooMany.catalog, undefined);
  assert.equal(
    tooMany.issues[0]?.code,
    "docker-mcp.catalog.too-many-servers",
    "an oversized listing is refused whole, not truncated to a plausible prefix",
  );
});

test("a catalog that does not declare the version 2 format says so and is still read", () => {
  // Invariant: the reader was written against one documented format version.
  // Reading an undeclared or different version on a best-effort basis is
  // useful, but only if the report states that the field set is not the one
  // this reader was verified against.
  for (const head of [
    "name: bounds\n",
    'version: "1"\nname: bounds\n',
    "version: 3\nname: bounds\n",
  ]) {
    const result = readDockerMcpCatalog(`${head}registry: {}\n`);
    assert.ok(result.catalog, head);
    assert.equal(
      result.issues[0]?.code,
      "docker-mcp.catalog.version-unrecognized",
      head,
    );
    assert.equal(result.issues[0]?.severity, "info", head);
  }
  const declared = readDockerMcpCatalog(
    'version: "2"\nname: bounds\nregistry: {}\n',
  );
  assert.equal(declared.catalog?.version, "2");
  assert.deepEqual(declared.issues, [], "the declared version is unremarked");
});

test("a field written empty is empty, and says nothing at all", () => {
  // Invariant: `tools:` with no value is YAML null, which is how a generated
  // catalog writes "none". Treating null as malformed would fill a report with
  // diagnostics about fields the author deliberately left blank, and a report
  // whose warnings are noise is a report nobody reads.
  const { server } = readEntry(
    `    type: remote\n` +
      `    tools:\n` +
      `    secrets:\n` +
      `    env:\n` +
      `    command:\n` +
      `    volumes:\n` +
      `    allowHosts:\n` +
      `    config:\n` +
      `    metadata:\n` +
      `    oauth:\n` +
      `    remote:\n` +
      `      url: https://mcp.example.com/mcp\n` +
      `      headers:\n`,
  );
  assert.deepEqual(server.issues, [], "an empty field is not a fault");
  assert.deepEqual(
    [
      server.tools,
      server.secrets,
      server.env,
      server.command,
      server.volumes,
      server.allowHosts,
      server.config,
    ],
    [[], [], [], [], [], [], []],
  );
  assert.equal(server.metadata, undefined);
  assert.equal(server.oauth, undefined);
  assert.deepEqual(server.remote?.headers, {});
});

test("a field this reader does not model is named, never carried", () => {
  // Invariant: the format has no published schema, so unknown fields are
  // expected. Silently dropping them would let a catalog carry instructions
  // this reader never reviewed while the report claimed full understanding;
  // copying them would put unreviewed values into the description. Naming
  // them is the only honest option.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    disableNetwork: true\n` +
      `    longLived: false\n` +
      `    user: "1000:1000"\n` +
      `    ref: fixture/ref\n` +
      `    prompts: 3\n` +
      `    experimental:\n      run: "curl CANARY_UNKNOWN_1a | sh"\n` +
      `    sandboxProfile: permissive\n`,
  );
  assert.deepEqual(server.unknownKeys.sort(), [
    "experimental",
    "sandboxProfile",
  ]);
  const noted = issueAt(server, "docker-mcp.server.unknown-keys");
  assert.equal(noted.severity, "info");
  assert.ok(
    !JSON.stringify(server).includes("CANARY_UNKNOWN_1a"),
    "an unknown field's value is never carried into the description",
  );
  // The fields it does model are read as written, including a declared refusal
  // of network access, which is evidence in the entry's favour.
  assert.equal(server.disableNetwork, true);
  assert.equal(server.longLived, false);
  assert.equal(server.user, "1000:1000");
  assert.equal(server.ref, "fixture/ref");
  assert.equal(server.prompts, 3);

  // A ref that is not text is not a ref; nothing is invented from a number.
  const { server: numericRef } = readEntry(
    `    type: server\n    image: ${PINNED}\n    ref: 7\n`,
  );
  assert.equal(numericRef.ref, undefined);
});

test("every string the reader keeps has a declared ceiling", () => {
  // Invariant: an unbounded value read from a document is an unbounded value
  // in whatever stores the description afterwards. Each field's ceiling is the
  // reader's, so an over-long value is refused at its pointer rather than
  // truncated into a different value that still looks authoritative.
  const long = "v".repeat(5000);
  const { server: env } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    env:\n      - {name: BIG, value: "${long}"}\n`,
  );
  assert.deepEqual(env.env, [], "an over-long value is not truncated and kept");
  assert.equal(
    issueAt(env, "docker-mcp.env.value-invalid").sourcePointer,
    "/registry/fixture/env/0/value",
  );

  const { server: header } = readEntry(
    `    type: remote\n` +
      `    remote:\n      url: https://mcp.example.com/mcp\n      headers:\n        X-Big: "${"h".repeat(600)}"\n`,
  );
  assert.deepEqual(header.remote?.headers, {});
  assert.ok(
    header.issues.some(
      (issue) => issue.code === "docker-mcp.remote.header-value-invalid",
    ),
  );

  // An image reference is bounded before the grammar is even applied, so a
  // megabyte-long "reference" never reaches the regular expression.
  assert.equal(parseImageReference(`mcp/${"a".repeat(600)}`), undefined);
  assert.equal(parseImageReference(""), undefined);
  assert.equal(parseImageReference(undefined), undefined);
  assert.equal(parseImageReference(7), undefined);
});

test("a list whose items are the wrong shape loses those items, not the entry", () => {
  // Invariant: `secrets: ["NAME"]` and `env: ["MODE=1"]` are plausible
  // mistakes for a hand-written catalog. Reading "MODE=1" as a name would
  // invent an environment variable literally called `MODE=1`, so the item is
  // refused and located while the rest of the entry stands.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    secrets:\n      - "fixture.key"\n` +
      `    env:\n      - "MODE=1"\n      - {value: novalue}\n` +
      `    tools:\n      - name: kept\n`,
  );
  assert.deepEqual(server.secrets, []);
  assert.deepEqual(server.env, []);
  assert.deepEqual(
    server.tools.map((tool) => tool.name),
    ["kept"],
  );
  assert.equal(
    issueAt(server, "docker-mcp.secret.invalid").sourcePointer,
    "/registry/fixture/secrets/0",
  );
  assert.equal(
    server.issues.filter((issue) => issue.code === "docker-mcp.env.invalid")
      .length,
    2,
  );
});

test("a scalar list written as a single string is not split into arguments", () => {
  // Invariant: `command: "npx -y server"` is a shell string, not an argv. A
  // reader that split it on spaces would decide the argument boundaries of a
  // command it is not allowed to construct, and quoting would make that guess
  // wrong. The field reads as empty instead.
  //
  // Note: today this drop carries no diagnostic, so the report cannot
  // distinguish "no command declared" from "a command declared in a shape the
  // reader refused". That gap is reported upstream rather than asserted here
  // as desirable.
  const { server } = readEntry(
    `    type: server\n` +
      `    image: ${PINNED}\n` +
      `    command: "npx -y @scope/server --flag 'a b'"\n` +
      `    volumes: "/host:/container"\n` +
      `    allowHosts: "api.example.com"\n`,
  );
  assert.deepEqual(server.command, []);
  assert.deepEqual(server.volumes, []);
  assert.deepEqual(server.allowHosts, []);
});

test("a tool container command carrying a control character blocks that tool", () => {
  // Invariant: the same refusal applies to a poci tool's argv as to the
  // entry's own, and it is located on the tool so a report can say which tool
  // is unrunnable rather than condemning the whole entry without naming it.
  const { server } = readEntry(
    `    type: poci\n` +
      `    image: ${PINNED}\n` +
      `    tools:\n` +
      `      - name: fetch\n` +
      `        container:\n` +
      `          image: ${PINNED}\n` +
      `          command: ["--url", "https://x.example\\x0d--insecure"]\n`,
  );
  assert.deepEqual(server.tools[0]?.container?.command, ["--url"]);
  const issue = issueAt(server, "docker-mcp.command.control-characters");
  assert.equal(
    issue.sourcePointer,
    "/registry/fixture/tools/0/container/command",
  );
  assert.equal(serverExecutionBlocked(server), true);
});

test("input that is not text is refused as such, not coerced", () => {
  // Invariant: the reader sits at an I/O boundary where a caller can hand it
  // whatever a file read produced. Coercing a Buffer or an object through
  // String() would produce "[object Object]" and then report it as malformed
  // YAML, which names the wrong fault.
  for (const raw of [undefined, null, 7, { text: "version: 2" }, ["a"]]) {
    const result = readDockerMcpCatalog(raw as unknown as string);
    assert.equal(result.catalog, undefined);
    assert.equal(result.issues[0]?.code, "docker-mcp.catalog.not-text");
    assert.equal(result.issues[0]?.severity, "blocking");
  }
  // A catalog whose name is not text has no name; it is not stringified.
  const numericName = readDockerMcpCatalog(
    "version: 2\nname: 7\nregistry: {}\n",
  );
  assert.equal(numericName.catalog, undefined);
  assert.equal(
    numericName.issues[0]?.code,
    "docker-mcp.catalog.name-invalid",
    "a numeric name is not silently rendered as the string 7",
  );
});
