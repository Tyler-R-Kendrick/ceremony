import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import type { ActorContext } from "../src/core/operation-contracts.js";
import {
  operationPackEnvelopeSchema,
  operationPackManifestSchema,
  operationPackSigningPayload,
  type OperationPackManifest,
  type PackOperation,
} from "../src/core/operation-packs.js";
import type { RecipeDefinition } from "../src/core/recipe-contracts.js";
import { commandEnvelopeSchema } from "../src/core/teaching-contracts.js";
import {
  ProtectedCommandService,
  type RunContext,
  type RunPlanNode,
} from "../src/server/commands.js";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import {
  loadOperationPacks,
  OperationPackRefused,
  prepareOperationPacks,
  registerOperationPacks,
  revocationList,
  type OperationPackOptions,
  type PreparedOperationPacks,
} from "../src/server/operation-packs.js";
import {
  OperationPackLimiter,
  processIsolationArguments,
  runInSandbox,
} from "../src/server/operation-pack-sandbox.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { loopbackAuthFetch } from "../src/server/public-auth-fetch.js";
import {
  commonVocabulary,
  mintOAuthClient,
} from "../src/server/recipes/common.js";
import { validateRecipe } from "../src/server/recipes/index.js";
import {
  OperationRegistry,
  type VocabularyEntry,
} from "../src/server/recipes/registry.js";
import { listOperations } from "../src/server/teaching-operations.js";
import { registerTeachingTools } from "../src/server/mcp-teaching.js";
import { teachingHttp } from "../src/server/teaching-http.js";

/*
 * Operation packs end to end: a pack signed in-test with a key generated
 * in-test, loaded from a temporary directory, run through the real command
 * service against a loopback fixture server reached through the host's
 * egress transport. No network beyond 127.0.0.1.
 */

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "alice",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher"],
};
const SECRET = `fixture-secret-${randomBytes(12).toString("hex")}`;
const CLIENT_SECRET = `client-secret-${randomBytes(12).toString("hex")}`;

const fixture = (
  schema: z.ZodType,
  classification: VocabularyEntry["classification"],
): VocabularyEntry => ({
  schema,
  classification,
  provider: "fixture",
  profile: "fixture-api",
});
const vocabulary = new Map<string, VocabularyEntry>([
  ...commonVocabulary,
  ["fixture.account", fixture(z.string().regex(/^[a-z0-9-]{1,40}$/), "public")],
  ["fixture.plan", fixture(z.enum(["free", "pro"]), "public")],
  ["fixture.note", fixture(z.string().max(200_000), "public")],
  [
    "fixture.session",
    fixture(z.string().regex(/^fixture-[a-f0-9]{8}$/), "artifact"),
  ],
]);
const fixtureContext: RunContext = {
  provider: "fixture",
  profile: "fixture-api",
  target: "self",
  origin: "https://app.example",
  environment: "test",
  configurationVersion: "v1",
};

function store(t: TestContext) {
  const value = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => value.close());
  return value;
}

type Seen = {
  method: string;
  url: string;
  authorization?: string;
  apiKey?: string;
};
/** A loopback provider double: echoes the authorization it received. */
async function fixtureServer(t: TestContext) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      ...(request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {}),
      ...(typeof request.headers["x-api-key"] === "string"
        ? { apiKey: request.headers["x-api-key"] }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/big") {
      response.end("x".repeat(300 * 1024));
      return;
    }
    response.end(
      JSON.stringify({
        plan: "pro",
        echo: request.headers.authorization ?? "",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

/** The handler bundle every fixture pack ships; each test signs the operations it needs. */
const handlerSource = (base: string, stray: string) => `
const BASE = ${JSON.stringify(base)};
const STRAY = ${JSON.stringify(stray)};
const operations = {
  lookup: {
    async run(input, ceremony) {
      const response = await ceremony.fetch({
        url: BASE + "/accounts/" + input.account,
        headers: { accept: "application/json" },
        credential: "apiKey",
      });
      const body = JSON.parse(response.body);
      return { outputs: { plan: body.plan, note: body.echo } };
    },
    async verify(outputs, ceremony) {
      const response = await ceremony.fetch({ url: BASE + "/plan", credential: "apiKey" });
      return response.status === 200 && outputs.plan === "pro";
    },
  },
  client: {
    async run(input, ceremony) {
      const response = await ceremony.fetch({ url: BASE + "/token", method: "POST", body: "grant_type=client_credentials", credential: "client" });
      return { outputs: { note: JSON.parse(response.body).echo + "|" + JSON.stringify(input) } };
    },
    verify() {
      return true;
    },
  },
  host: {
    run(input) {
      return { outputs: { host: input.host.toLowerCase() } };
    },
    verify(outputs) {
      return typeof outputs.host === "string";
    },
  },
  probe: {
    async run(input, ceremony) {
      const attempt = (reach) => {
        try {
          const value = reach();
          return value && typeof value === "object" && typeof value.pid === "number" ? "ESCAPED" : typeof value;
        } catch (error) {
          return "blocked";
        }
      };
      const results = [
        typeof require, typeof process, typeof globalThis.process, typeof module,
        typeof setTimeout, typeof fetch, typeof WebAssembly === "object" ? "wasm" : "no-wasm",
        attempt(() => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
        attempt(() => globalThis.constructor.constructor("return process")()),
        attempt(() => ceremony.constructor.constructor("return process")()),
        attempt(() => ceremony.fetch.constructor("return process")()),
        attempt(() => (async () => {}).constructor("return process")()),
        attempt(() => eval("process")),
        attempt(() => Function.prototype.constructor("return process")()),
      ];
      try {
        await import("node:fs");
        results.push("ESCAPED");
      } catch (error) {
        results.push("blocked");
      }
      Error.prepareStackTrace = (_, frames) => frames;
      const frames = new Error().stack;
      Error.prepareStackTrace = undefined;
      const reached = (Array.isArray(frames) ? frames : []).some((frame) => {
        for (const value of [frame.getThis && frame.getThis(), frame.getFunction && frame.getFunction()])
          if (value && attempt(() => value.constructor.constructor("return process")()) === "ESCAPED") return true;
        return false;
      });
      results.push(reached ? "ESCAPED" : "frames-contained");
      Object.prototype.polluted = "yes";
      return { outputs: { note: results.join(",") } };
    },
  },
  rules: {
    async run(input, ceremony) {
      const codes = [];
      const attempt = async (request) => {
        try {
          const response = await ceremony.fetch(request);
          codes.push(String(response.status));
        } catch (error) {
          codes.push(error.message);
        }
      };
      await attempt({ url: "not a url" });
      await attempt({ url: BASE + "/a", body: "x" });
      await attempt({ url: BASE + "/a", extra: true });
      await attempt({ url: BASE + "/big" });
      await attempt({ url: BASE + "/a", credential: "undeclared" });
      await attempt({ url: BASE + "/a", credential: "absent" });
      await attempt({ url: BASE + "/header", credential: "headerKey" });
      for (let index = 0; index < 10; index++) await attempt({ url: BASE + "/a" });
      return { outputs: { note: codes.join(",") } };
    },
  },
  stray: {
    async run(input, ceremony) {
      try { await ceremony.fetch({ url: STRAY + "/exfiltrate" }); } catch (error) {}
      return { outputs: { note: "done" } };
    },
  },
  poster: {
    async run(input, ceremony) {
      try { await ceremony.fetch({ url: BASE + "/change", method: "POST", body: "x" }); } catch (error) {}
      return { outputs: { note: "done" } };
    },
  },
  forger: {
    async run(input, ceremony) {
      let refused = "sent";
      try { await ceremony.fetch({ url: BASE + "/plan", headers: { Authorization: "Bearer forged" } }); } catch (error) { refused = error.message; }
      return { outputs: { note: refused } };
    },
  },
  writer: {
    async run(input, ceremony) {
      await ceremony.fetch({ url: BASE + "/change", method: "POST", body: "x" });
      for (;;) {}
    },
  },
  spin: { run() { for (;;) {} } },
  hang: { run() { return new Promise(() => {}); } },
  big: { run() { return { outputs: { note: "x".repeat(5000) } }; } },
  hog: { run() { const kept = []; for (;;) kept.push(new Array(1e6).fill(kept.length)); } },
  boom: { run() { throw new Error("internal detail " + BASE); } },
  refuse: { run() { return { failed: "conflict" }; } },
  malformed: { run() { return { outputs: { plan: "enterprise" } }; } },
};
`;

const fixtureOperation = (
  name: string,
  overrides: Partial<PackOperation> = {},
): PackOperation => ({
  name,
  version: "1.0.0",
  title: `Fixture ${name}`,
  description: "A fixture operation.",
  scope: { kind: "provider", provider: "fixture", profile: "fixture-api" },
  inputs: {},
  outputs: { note: { contract: "fixture.note", required: true } },
  effect: "read",
  destinations: [],
  credentials: {},
  verify: false,
  fixtures: ["tests/operation-packs.test.ts"],
  ...overrides,
});

type Publisher = { keyId: string; privateKey: KeyObject; publicPem: string };
function publisher(keyId = "fixture-publisher"): Publisher {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Write one signed pack; `after` may tamper with the files once signed. */
function writePack(
  directory: string,
  entry: string,
  options: {
    id?: string;
    operations: PackOperation[];
    handler: string;
    signer: Publisher;
    publisherId?: string;
    after?: (paths: { manifest: string; handler: string }) => void;
  },
): OperationPackManifest {
  const root = join(directory, entry);
  mkdirSync(root, { recursive: true });
  const bundle = Buffer.from(options.handler);
  const manifest = operationPackManifestSchema.parse({
    schemaVersion: 1,
    id: options.id ?? "fixture-pack",
    version: "1.2.0",
    title: "Fixture pack",
    description: "Operations for the operation-pack tests.",
    publisher: options.publisherId ?? options.signer.keyId,
    bundle: {
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.byteLength,
    },
    operations: options.operations,
  });
  const envelope = operationPackEnvelopeSchema.parse({
    manifest,
    signature: {
      algorithm: "ed25519",
      keyId: manifest.publisher,
      value: sign(
        null,
        operationPackSigningPayload(manifest),
        options.signer.privateKey,
      ).toString("base64"),
    },
  });
  const paths = {
    manifest: join(root, "pack.json"),
    handler: join(root, "handler.js"),
  };
  writeFileSync(paths.manifest, JSON.stringify(envelope, null, 2));
  writeFileSync(paths.handler, bundle);
  options.after?.(paths);
  return manifest;
}

function packDirectory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "operation-packs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

type Setup = {
  registry: OperationRegistry;
  commands: ProtectedCommandService;
  server: Awaited<ReturnType<typeof fixtureServer>>;
  stray: Awaited<ReturnType<typeof fixtureServer>>;
  store: SQLiteCeremonyStore;
};
type LoadOptions = Partial<OperationPackOptions> & {
  withoutSecrets?: true;
  untrusted?: true;
};
/** Load one signed pack with the given operations into a fresh registry. */
async function loaded(
  t: TestContext,
  operations: (base: string, stray: string) => PackOperation[],
  options: LoadOptions = {},
): Promise<Setup & { report: Awaited<ReturnType<typeof loadOperationPacks>> }> {
  const { withoutSecrets, untrusted, ...overrides } = options;
  const server = await fixtureServer(t);
  const stray = await fixtureServer(t);
  const directory = packDirectory(t);
  const signer = publisher();
  writePack(directory, "fixture", {
    operations: operations(server.origin, stray.origin),
    handler: handlerSource(server.origin, stray.origin),
    signer,
  });
  const database = store(t);
  const registry = new OperationRegistry(vocabulary);
  // A host step that mints a client registration another step can use.
  registry.register({
    contract: {
      id: "fixture.mint-client",
      version: "1.0.0",
      provider: "fixture",
      profile: "fixture-api",
      inputs: {},
      outputs: { client: { contract: "common.oauth-client", required: true } },
      effects: ["fixture.mint-client"],
      verifier: "fixture.mint-client",
      humanFallback: "none",
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ client: z.string() }),
    classifications: {},
    fixtures: ["tests/operation-packs.test.ts"],
    handler: async (context) => ({
      state: "complete",
      outputs: {
        client: await mintOAuthClient(database, context, {
          clientId: "fixture client",
          clientSecret: CLIENT_SECRET,
        }),
      },
    }),
    verify: async () => true,
  });
  const report = await loadOperationPacks(registry, {
    directory,
    publishers: [
      {
        keyId: signer.keyId,
        publicKey: signer.publicPem,
        ...(untrusted ? { untrusted } : {}),
      },
    ],
    fetch: loopbackAuthFetch,
    loopbackFixtures: true,
    store: database,
    ...(withoutSecrets
      ? {}
      : {
          secrets: async ({ name }: { name: string }) =>
            name === "fixture-api-key" ? SECRET : undefined,
        }),
    ...overrides,
  });
  return {
    registry,
    commands: new ProtectedCommandService(database, registry, async () => true),
    server,
    stray,
    store: database,
    report,
  };
}

const lookupOperation = (base: string) =>
  fixtureOperation("lookup", {
    inputs: { account: { contract: "fixture.account", required: true } },
    outputs: {
      plan: { contract: "fixture.plan", required: true },
      note: { contract: "fixture.note", required: true },
    },
    destinations: [base],
    credentials: {
      apiKey: {
        source: "host",
        name: "fixture-api-key",
        placement: { kind: "bearer" },
      },
    },
    verify: true,
    replay: "read-only",
  });

/** Call a pack operation's registered handler directly, as the command service would. */
function direct(
  setup: Pick<Setup, "registry">,
  name: string,
  signal = AbortSignal.timeout(30_000),
  inputs: Record<string, unknown> = {},
) {
  return setup.registry.require(`pack:fixture-pack/${name}`, "1.0.0").handler(
    {
      actor,
      runId: "run:none",
      nodeId: name,
      commandId: name,
      effectId: name,
      target: "self",
      configurationVersion: "v1",
      origin: "https://app.example",
      environment: "test",
      signal,
    },
    inputs,
  );
}

/** Plan and advance a single-step run; returns the node's state and outputs. */
async function runStep(
  setup: Setup,
  operationId: string,
  bindings: RunPlanNode["bindings"] = {},
  inputs: Record<string, unknown> = {},
  context: RunContext = fixtureContext,
) {
  const run = await setup.commands.createRun(
    actor,
    context,
    [
      {
        id: "step",
        operationId,
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings,
      },
    ],
    inputs,
  );
  const status = await setup.commands.advance(
    actor,
    run.id,
    "step",
    run.revision,
    `command-${randomUUID()}`,
  );
  const node = await setup.store.transaction((tx) =>
    tx.get<{
      state: string;
      verified: boolean;
      outputs: Record<string, unknown>;
    }>({ tenant: actor.tenantId, kind: "node", id: `${run.id}:step` }),
  );
  return { status, node: node!.value };
}

test("a signed pack loads, registers namespaced operations and runs in a recipe", async (t) => {
  const setup = await loaded(t, (base) => [lookupOperation(base)]);
  assert.deepEqual(setup.report.refused, []);
  const id = "pack:fixture-pack/lookup";
  assert.deepEqual(setup.report.loaded, [
    {
      pack: "fixture-pack",
      version: "1.2.0",
      publisher: "fixture-publisher",
      operations: [{ id, version: "1.0.0" }],
    },
  ]);
  assert.deepEqual(setup.registry.provenance(id, "1.0.0"), {
    kind: "pack",
    pack: "fixture-pack",
    packVersion: "1.2.0",
    publisher: "fixture-publisher",
    effect: "read",
    destinations: [setup.server.origin],
    isolation: "worker",
  });
  assert.deepEqual(setup.registry.provenance("fixture.mint-client", "1.0.0"), {
    kind: "host",
  });

  // It composes like a built-in: a recipe names it and validates clean.
  const recipe: RecipeDefinition = {
    schemaVersion: 1,
    id: "fixture-plan",
    title: "Read the fixture plan",
    description: "Uses a pack operation.",
    inputs: { account: { contract: "fixture.account", required: true } },
    invocations: [
      {
        id: "lookup",
        use: { kind: "operation", id, version: "1.0.0" },
        dependsOn: [],
        bindings: { account: { from: "input", name: "account" } },
        outcome: {
          successCriteria: ["$statusCode == 200"],
          retry: { limit: 1, afterMs: 0, criteria: [] },
          values: {},
        },
      },
    ],
    outputs: { plan: { node: "lookup", name: "plan" } },
  };
  const checked = await validateRecipe(recipe, setup.registry, async () => {
    throw new Error("no children");
  });
  assert.deepEqual(checked.diagnostics, []);
  assert.ok(
    commandEnvelopeSchema.safeParse({
      commandId: "c",
      runId: "r",
      nodeId: "n",
      expectedRevision: 0,
      operationId: id,
      operationVersion: "1.0.0",
      bindings: {},
    }).success,
  );

  const run = await setup.commands.createRun(
    actor,
    fixtureContext,
    checked.leaves.map((leaf) => ({
      id: leaf.id,
      operationId: leaf.use.id,
      operationVersion: leaf.use.version,
      dependsOn: leaf.dependsOn,
      bindings: leaf.bindings,
      ...(leaf.outcome ? { outcome: leaf.outcome } : {}),
    })),
    { account: "alice" },
  );
  const status = await setup.commands.advance(
    actor,
    run.id,
    "lookup",
    run.revision,
    "command-lookup",
  );
  assert.equal(status.state, "complete");
  assert.equal(status.verified, true);
  const node = await setup.store.transaction((tx) =>
    tx.get<{ outputs: Record<string, unknown> }>({
      tenant: actor.tenantId,
      kind: "node",
      id: `${run.id}:lookup`,
    }),
  );
  // The provider received the injected credential; the handler, reading the
  // provider's echo of it, saw only the redaction.
  assert.deepEqual(node!.value.outputs, {
    plan: "pro",
    note: "Bearer [redacted]",
  });
  assert.deepEqual(
    setup.server.seen.map(({ method, url, authorization }) => ({
      method,
      url,
      authorization,
    })),
    [
      {
        method: "GET",
        url: "/accounts/alice",
        authorization: `Bearer ${SECRET}`,
      },
      { method: "GET", url: "/plan", authorization: `Bearer ${SECRET}` },
    ],
  );
  const stored = JSON.stringify(
    await setup.store.transaction((tx) => tx.list(actor.tenantId, "node", 50)),
  );
  assert.ok(!stored.includes(SECRET));
});

test("admission, the pack namespace and the registry's vocabulary rules hold for pack operations", async (t) => {
  const setup = await loaded(t, () => [
    fixtureOperation("host", {
      scope: { kind: "neutral" },
      inputs: { host: { contract: "common.link-host", required: true } },
      outputs: { host: { contract: "common.link-host", required: true } },
      verify: true,
    }),
    fixtureOperation("big"),
  ]);
  assert.deepEqual(setup.report.refused, []);
  const other = { provider: "other", profile: "other-profile" };
  // A provider-scoped pack step is admitted only under its provider.
  assert.equal(
    setup.commands.admits(fixtureContext, "pack:fixture-pack/big", "1.0.0"),
    true,
  );
  assert.equal(
    setup.commands.admits(other, "pack:fixture-pack/big", "1.0.0"),
    false,
  );
  await assert.rejects(
    runStep(
      setup,
      "pack:fixture-pack/big",
      {},
      {},
      {
        ...fixtureContext,
        ...other,
      },
    ),
    /denied/,
  );
  // A neutral one joins any run, over neutral vocabulary only.
  assert.equal(
    setup.commands.admits(other, "pack:fixture-pack/host", "1.0.0"),
    true,
  );
  assert.equal(
    setup.registry.isNeutral("pack:fixture-pack/host", "1.0.0"),
    true,
  );
  const neutral = await runStep(
    setup,
    "pack:fixture-pack/host",
    { host: { from: "literal", value: "provider.example" } },
    {},
    { ...fixtureContext, ...other },
  );
  assert.equal(neutral.status.state, "complete");
  assert.deepEqual(neutral.node.outputs, { host: "provider.example" });

  // Host code can neither claim the namespace nor a pack another's.
  const operation = setup.registry.require("pack:fixture-pack/big", "1.0.0");
  assert.throws(
    () =>
      setup.registry.register({
        ...operation,
        contract: { ...operation.contract, version: "9.0.0" },
      }),
    /only from packs/,
  );
  assert.throws(
    () =>
      setup.registry.registerPack(
        { ...operation, contract: { ...operation.contract, version: "9.0.0" } },
        {
          kind: "pack",
          pack: "other-pack",
          packVersion: "1.0.0",
          publisher: "x",
          effect: "read",
          destinations: [],
          isolation: "worker",
        },
      ),
    /namespace/,
  );
  assert.throws(
    () =>
      setup.registry.registerPack(
        {
          ...operation,
          contract: { ...operation.contract, id: "fixture.pretend" },
        },
        {
          kind: "pack",
          pack: "fixture-pack",
          packVersion: "1.0.0",
          publisher: "x",
          effect: "read",
          destinations: [],
          isolation: "worker",
        },
      ),
    /namespace/,
  );
  // A step without a verifier is refused by recipe validation, as a built-in is.
  const checked = await validateRecipe(
    {
      schemaVersion: 1,
      id: "unverified",
      title: "Unverified",
      description: "",
      inputs: {},
      invocations: [
        {
          id: "big",
          use: {
            kind: "operation",
            id: "pack:fixture-pack/big",
            version: "1.0.0",
          },
          dependsOn: [],
          bindings: {},
        },
      ],
      outputs: {},
    },
    setup.registry,
    async () => {
      throw new Error("no children");
    },
  );
  assert.deepEqual(checked.diagnostics, [
    { code: "missing-verifier", node: "big" },
  ]);
});

test("an oauth-client credential is resolved in custody and never enters the sandbox", async (t) => {
  const setup = await loaded(t, (base) => [
    fixtureOperation("client", {
      effect: "write",
      inputs: { client: { contract: "common.oauth-client", required: true } },
      destinations: [base],
      credentials: { client: { source: "oauth-client", input: "client" } },
      verify: true,
    }),
  ]);
  assert.deepEqual(setup.report.refused, []);
  const run = await setup.commands.createRun(
    actor,
    fixtureContext,
    [
      {
        id: "mint",
        operationId: "fixture.mint-client",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "use",
        operationId: "pack:fixture-pack/client",
        operationVersion: "1.0.0",
        dependsOn: ["mint"],
        bindings: { client: { from: "output", node: "mint", name: "client" } },
      },
    ],
    {},
  );
  let snapshot = await setup.commands.advance(
    actor,
    run.id,
    "mint",
    run.revision,
    "command-mint",
  );
  snapshot = await setup.commands.advance(
    actor,
    run.id,
    "use",
    snapshot.revision,
    "command-use",
  );
  assert.equal(snapshot.state, "complete");
  const node = await setup.store.transaction((tx) =>
    tx.get<{ outputs: { note: string } }>({
      tenant: actor.tenantId,
      kind: "node",
      id: `${run.id}:use`,
    }),
  );
  const expected = `Basic ${Buffer.from(`fixture+client:${CLIENT_SECRET}`).toString("base64")}`;
  assert.equal(setup.server.seen[0]!.authorization, expected);
  // The echo came back redacted and the handler's input carried no handle.
  assert.equal(node!.value.outputs.note, "Basic [redacted]|{}");
});

test("tampered, unknown, expired and revoked packs are refused with a reason and register nothing", async (t) => {
  const directory = packDirectory(t);
  const trusted = publisher("trusted-key");
  const stranger = publisher("stranger-key");
  const expired = publisher("expired-key");
  const revoked = publisher("revoked-key");
  const future = publisher("future-key");
  const narrow = publisher("narrow-key");
  const handler = handlerSource("https://api.fixture.example", "");
  const operations = [fixtureOperation("big")];
  writePack(directory, "a-good", {
    id: "good",
    operations,
    handler,
    signer: trusted,
  });
  writePack(directory, "b-manifest", {
    id: "manifest-tampered",
    operations,
    handler,
    signer: trusted,
    after: ({ manifest }) => {
      const envelope = JSON.parse(readFileSync(manifest, "utf8")) as {
        manifest: OperationPackManifest;
      };
      envelope.manifest.operations[0]!.effect = "write";
      writeFileSync(manifest, JSON.stringify(envelope));
    },
  });
  writePack(directory, "c-handler", {
    id: "handler-tampered",
    operations,
    handler,
    signer: trusted,
    after: ({ handler: path }) => writeFileSync(path, handler + "\n// added"),
  });
  writePack(directory, "d-unknown", {
    id: "unknown",
    operations,
    handler,
    signer: stranger,
  });
  // A stranger signing under a trusted key id does not verify.
  writePack(directory, "e-impostor", {
    id: "impostor",
    operations,
    handler,
    signer: stranger,
    publisherId: "trusted-key",
  });
  writePack(directory, "f-expired", {
    id: "expired",
    operations,
    handler,
    signer: expired,
  });
  writePack(directory, "g-revoked", {
    id: "revoked",
    operations,
    handler,
    signer: revoked,
  });
  writePack(directory, "h-future", {
    id: "future",
    operations,
    handler,
    signer: future,
  });
  writePack(directory, "i-narrow", {
    id: "not-listed",
    operations,
    handler,
    signer: narrow,
  });
  writePack(directory, "j-duplicate", {
    id: "good",
    operations,
    handler,
    signer: trusted,
  });
  writeFileSync(join(directory, "k-file"), "not a pack");
  mkdirSync(join(directory, "l-empty"));
  mkdirSync(join(directory, "m-garbage"));
  writeFileSync(join(directory, "m-garbage", "pack.json"), "{");
  writePack(directory, "n-key-mismatch", {
    id: "key-mismatch",
    operations,
    handler,
    signer: trusted,
    after: ({ manifest }) => {
      const envelope = JSON.parse(readFileSync(manifest, "utf8")) as {
        signature: { keyId: string };
      };
      envelope.signature.keyId = "expired-key";
      writeFileSync(manifest, JSON.stringify(envelope));
    },
  });
  symlinkSync(join(directory, "a-good"), join(directory, "o-link"));
  const registry = new OperationRegistry(vocabulary);
  const report = await loadOperationPacks(registry, {
    directory,
    publishers: [trusted, expired, revoked, future, narrow].map((key) => ({
      keyId: key.keyId,
      publicKey: key.publicPem,
      ...(key === expired ? { notAfter: "2020-01-01T00:00:00Z" } : {}),
      ...(key === future ? { notBefore: "2999-01-01T00:00:00Z" } : {}),
      ...(key === narrow ? { packs: ["something-else"] } : {}),
    })),
    revokedKeys: ["revoked-key"],
  });
  assert.deepEqual(
    report.refused.map(({ entry, reason }) => [entry, reason]),
    [
      ["b-manifest", "bad-signature"],
      ["c-handler", "bundle-digest-mismatch"],
      ["d-unknown", "unknown-publisher"],
      ["e-impostor", "bad-signature"],
      ["f-expired", "publisher-expired"],
      ["g-revoked", "publisher-revoked"],
      ["h-future", "publisher-not-yet-valid"],
      ["i-narrow", "publisher-not-allowed"],
      ["j-duplicate", "duplicate-operation"],
      ["k-file", "invalid-layout"],
      ["l-empty", "invalid-layout"],
      ["m-garbage", "invalid-manifest"],
      ["n-key-mismatch", "invalid-manifest"],
      ["o-link", "invalid-layout"],
    ],
  );
  for (const refusal of report.refused)
    assert.ok(refusal.message.length > 0 && !refusal.message.includes("{"));
  assert.deepEqual(
    report.loaded.map(({ pack }) => pack),
    ["good"],
  );
  assert.deepEqual(
    registry.catalog().map(({ id }) => id),
    ["pack:good/big"],
  );
  // Host misconfiguration is not a refusal: it stops startup.
  await assert.rejects(
    () =>
      loadOperationPacks(new OperationRegistry(vocabulary), {
        directory,
        publishers: [
          {
            keyId: "rsa",
            publicKey: generateKeyPairSync("rsa", { modulusLength: 1024 })
              .publicKey,
          },
        ],
      }),
    /not an Ed25519 key/,
  );
});

test("an operation outside the host's vocabulary, classification or destination policy does not load", async (t) => {
  const cases: Array<[string, PackOperation, LoadOptions]> = [
    [
      "unknown-vocabulary",
      fixtureOperation("big", {
        outputs: { note: { contract: "fixture.missing", required: true } },
      }),
      {},
    ],
    [
      "forbidden-classification",
      fixtureOperation("big", {
        outputs: { note: { contract: "fixture.session", required: true } },
      }),
      {},
    ],
    [
      "forbidden-classification",
      fixtureOperation("big", {
        inputs: { session: { contract: "fixture.session", required: true } },
      }),
      {},
    ],
    [
      "provider-mismatch",
      fixtureOperation("big", { scope: { kind: "neutral" } }),
      {},
    ],
    [
      "provider-mismatch",
      fixtureOperation("big", {
        scope: { kind: "provider", provider: "other", profile: "fixture-api" },
      }),
      {},
    ],
    [
      "destination-refused",
      fixtureOperation("big", { destinations: ["http://127.0.0.1:9"] }),
      { loopbackFixtures: false },
    ],
    [
      "destination-refused",
      fixtureOperation("big", {
        destinations: ["https://api.fixture.example"],
      }),
      { allowDestination: () => false },
    ],
    [
      "credential-unavailable",
      fixtureOperation("big", {
        destinations: ["https://api.fixture.example"],
        credentials: {
          key: {
            source: "host",
            name: "fixture-api-key",
            placement: { kind: "header", name: "x-api-key" },
          },
        },
      }),
      { withoutSecrets: true },
    ],
    [
      "credential-unavailable",
      fixtureOperation("big", {
        inputs: { client: { contract: "fixture.account", required: true } },
        destinations: ["https://api.fixture.example"],
        credentials: { key: { source: "oauth-client", input: "client" } },
      }),
      {},
    ],
  ];
  for (const [reason, operation, options] of cases) {
    const setup = await loaded(t, () => [operation], options);
    assert.deepEqual(
      setup.report.refused.map((refusal) => refusal.reason),
      [reason],
      `${reason}: ${JSON.stringify(operation)}`,
    );
    assert.equal(
      setup.registry.get("pack:fixture-pack/big", "1.0.0"),
      undefined,
    );
  }
  // The manifest itself refuses what it cannot express safely.
  assert.equal(
    operationPackManifestSchema.safeParse({
      schemaVersion: 1,
      id: "x",
      version: "1.0.0",
      title: "x",
      description: "",
      publisher: "k",
      bundle: { sha256: "0".repeat(64), bytes: 1 },
      operations: [
        fixtureOperation("big", { effect: "write", replay: "read-only" }),
      ],
    }).success,
    false,
  );
  for (const destination of [
    "http://api.fixture.example",
    "https://api.fixture.example/path",
    "https://user@api.fixture.example",
  ])
    assert.equal(
      operationPackManifestSchema.safeParse({
        schemaVersion: 1,
        id: "x",
        version: "1.0.0",
        title: "x",
        description: "",
        publisher: "k",
        bundle: { sha256: "0".repeat(64), bytes: 1 },
        operations: [fixtureOperation("big", { destinations: [destination] })],
      }).success,
      false,
      destination,
    );
});

test("the sandbox gives a handler no ambient authority and no way back to the host realm", async (t) => {
  const setup = await loaded(t, () => [fixtureOperation("probe")]);
  const result = await direct(setup, "probe");
  assert.equal(result.state, "complete");
  assert.equal(
    result.outputs.note,
    [
      "undefined", // require
      "undefined", // process
      "undefined", // globalThis.process
      "undefined", // module
      "undefined", // setTimeout
      "undefined", // fetch
      "wasm", // the object exists; compiling is refused
      "blocked", // new WebAssembly.Module
      "blocked", // globalThis.constructor.constructor
      "blocked", // ceremony.constructor.constructor
      "blocked", // ceremony.fetch.constructor
      "blocked", // AsyncFunction constructor
      "blocked", // eval
      "blocked", // Function.prototype.constructor
      "blocked", // import()
      "frames-contained",
    ].join(","),
  );
  // Prototype pollution inside the context stays there.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("an undeclared destination, a write from a read and a forged authorization are refused", async (t) => {
  const setup = await loaded(t, (base) => [
    fixtureOperation("stray", { destinations: [base] }),
    fixtureOperation("poster", { destinations: [base] }),
    fixtureOperation("forger", { destinations: [base] }),
  ]);
  const denied = {
    state: "failed",
    outputs: {},
    diagnosticCode: "denied",
  };
  // The handler swallowed each refusal and reported success; the host still
  // fails the step, naming only the fixed code.
  assert.deepEqual(await direct(setup, "stray"), denied);
  assert.deepEqual(await direct(setup, "poster"), denied);
  assert.deepEqual((await direct(setup, "forger")).outputs, {
    note: "invalid-request",
  });
  assert.deepEqual(setup.stray.seen, []);
  assert.deepEqual(setup.server.seen, []);
});

test("the fetch capability enforces its request rules and the host's credential answers", async (t) => {
  const setup = await loaded(t, (base) => [
    fixtureOperation("rules", {
      destinations: [base],
      credentials: {
        absent: {
          source: "host",
          name: "not-configured",
          placement: { kind: "bearer" },
        },
        headerKey: {
          source: "host",
          name: "fixture-api-key",
          placement: { kind: "header", name: "X-Api-Key" },
        },
      },
    }),
  ]);
  const result = await direct(setup, "rules");
  assert.equal(result.state, "complete");
  assert.equal(
    result.outputs.note,
    [
      "invalid-request", // not a URL
      "invalid-request", // a body on GET
      "invalid-request", // an unknown request field
      "too-large", // response over the cap
      "unavailable", // an undeclared credential
      "unavailable", // the host has no value for it
      "200", // the header placement
      ...Array.from({ length: 9 }, () => "200"),
      "limit", // the seventeenth request
    ].join(","),
  );
  assert.equal(
    setup.server.seen.find(({ url }) => url === "/header")?.apiKey,
    SECRET,
  );
});

test("timeouts, memory, oversized output and handler errors map to operation codes without internals", async (t) => {
  const setup = await loaded(t, (base) => [
    fixtureOperation("spin", { limits: { timeoutMs: 300 } }),
    fixtureOperation("hang", { limits: { timeoutMs: 300 } }),
    fixtureOperation("big", { limits: { outputBytes: 1024 } }),
    fixtureOperation("hog", { limits: { memoryMb: 16, timeoutMs: 20_000 } }),
    fixtureOperation("boom"),
    fixtureOperation("refuse"),
    fixtureOperation("malformed", {
      outputs: { plan: { contract: "fixture.plan", required: true } },
    }),
    fixtureOperation("writer", {
      effect: "write",
      destinations: [base],
      limits: { timeoutMs: 1000 },
    }),
  ]);
  assert.deepEqual(setup.report.refused, []);
  const call = (name: string, signal?: AbortSignal) =>
    direct(setup, name, signal);
  const unavailable = {
    state: "failed",
    outputs: {},
    diagnosticCode: "unavailable",
  };
  const started = Date.now();
  assert.deepEqual(await call("spin"), unavailable);
  assert.deepEqual(await call("hang"), unavailable);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(await call("big"), unavailable);
  assert.deepEqual(await call("hog"), unavailable);
  const boom = await call("boom");
  assert.deepEqual(boom, unavailable);
  assert.ok(!JSON.stringify(boom).includes("internal detail"));
  assert.deepEqual(await call("refuse"), {
    state: "failed",
    outputs: {},
    diagnosticCode: "conflict",
  });
  assert.deepEqual(await call("malformed"), unavailable);
  // A write that left before the handler died may have landed.
  assert.deepEqual(await call("writer"), {
    state: "uncertain",
    outputs: {},
    diagnosticCode: "uncertain",
  });
  assert.equal(setup.server.seen.length, 1);
  const controller = new AbortController();
  const cancelled = call("hang", controller.signal);
  controller.abort();
  assert.deepEqual(await cancelled, {
    state: "failed",
    outputs: {},
    diagnosticCode: "cancelled",
  });
});

test("a key that expires or is revoked after load stops its operations", async (t) => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const server = await fixtureServer(t);
  const directory = packDirectory(t);
  const signer = publisher();
  writePack(directory, "fixture", {
    operations: [fixtureOperation("big")],
    handler: handlerSource(server.origin, ""),
    signer,
  });
  const registry = new OperationRegistry(vocabulary);
  const report = await loadOperationPacks(registry, {
    directory,
    publishers: [
      {
        keyId: signer.keyId,
        publicKey: signer.publicPem,
        notAfter: "2026-06-01T00:00:00Z",
      },
    ],
    now: () => now,
  });
  assert.equal(report.refused.length, 0);
  now = Date.parse("2026-07-01T00:00:00Z");
  const result = await direct({ registry }, "big");
  assert.deepEqual(result, {
    state: "failed",
    outputs: {},
    diagnosticCode: "denied",
  });
});

test("the reference runtime loads packs at startup and marks them in the MCP and HTTP operation catalogs", async (t) => {
  const directory = packDirectory(t);
  const signer = publisher();
  writePack(directory, "neutral", {
    id: "neutral-pack",
    operations: [
      fixtureOperation("host", {
        scope: { kind: "neutral" },
        inputs: { host: { contract: "common.link-host", required: true } },
        outputs: { host: { contract: "common.link-host", required: true } },
        verify: true,
      }),
    ],
    handler: handlerSource("https://api.fixture.example", ""),
    signer,
  });
  const runtime = createGitHubRuntime({
    store: store(t),
    identity: { authenticate: async () => actor },
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
    stripe: { configuration: async () => ({ version: "v1" }) },
    allowTarget: async () => true,
    authorize: async (subject, run) => subject.subjectId === run.subjectId,
    operationPacks: {
      packs: await prepareOperationPacks({
        directory,
        publishers: [{ keyId: signer.keyId, publicKey: signer.publicPem }],
      }),
    },
  });
  const listed = listOperations(runtime, actor);
  const pack = listed.find(({ id }) => id === "pack:neutral-pack/host")!;
  assert.deepEqual(pack.source, {
    kind: "pack",
    pack: "neutral-pack",
    packVersion: "1.2.0",
    publisher: "fixture-publisher",
    effect: "read",
    destinations: [],
    isolation: "worker",
  });
  assert.equal(pack.neutral, true);
  assert.deepEqual(
    listed.find(({ id }) => id === "common.provision-inbox")!.source,
    { kind: "host" },
  );
  assert.throws(
    () => listOperations(runtime, { ...actor, capabilities: ["publisher"] }),
    /denied/,
  );

  // A stripe run includes the neutral pack step like any common step.
  const recipe: RecipeDefinition = {
    schemaVersion: 1,
    id: "normalize-host",
    title: "Normalize a host",
    description: "A neutral pack step in a stripe run.",
    inputs: {},
    invocations: [
      {
        id: "host",
        use: {
          kind: "operation",
          id: "pack:neutral-pack/host",
          version: "1.0.0",
        },
        dependsOn: [],
        bindings: { host: { from: "literal", value: "provider.example" } },
      },
    ],
    outputs: { host: { node: "host", name: "host" } },
  };
  const run = await runtime.executeRecipe(actor, recipe, {}, "stripe");
  const status = await runtime.commands.advance(
    actor,
    run.id,
    "host",
    run.revision,
    "command-host",
  );
  assert.equal(status.state, "complete");
  assert.equal(status.verified, true);

  // Over HTTP and MCP, the same catalog, pack-marked.
  const response = await teachingHttp(
    new Request("https://app.example/api/v1/teaching/recipes/operations", {
      headers: { origin: "https://app.example" },
    }),
    runtime,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { operations: typeof listed };
  assert.deepEqual(
    body.operations.find(({ id }) => id === "pack:neutral-pack/host")?.source,
    pack.source,
  );
  const tools = new Map<string, (input: unknown) => Promise<unknown>>();
  registerTeachingTools(
    {
      registerTool: (
        name: string,
        _config: unknown,
        handler: (input: unknown) => Promise<unknown>,
      ) => tools.set(name, handler),
    } as never,
    runtime,
    {
      actor,
      run: async (operate) =>
        ({ structuredContent: await operate(actor) }) as never,
    },
  );
  const result = (await tools.get("ceremony_operations")!({})) as {
    structuredContent: { operations: typeof listed };
  };
  assert.deepEqual(
    result.structuredContent.operations.find(
      ({ id }) => id === "pack:neutral-pack/host",
    )?.source.kind,
    "pack",
  );

  // Without onRefused, a refused pack stops startup; with it, the host decides.
  writeFileSync(join(directory, "neutral", "handler.js"), "tampered");
  const tampered = await prepareOperationPacks({
    directory,
    publishers: [{ keyId: signer.keyId, publicKey: signer.publicPem }],
  });
  const options = {
    store: store(t),
    identity: { authenticate: async () => actor },
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
    authorize: async () => true,
  };
  assert.throws(
    () =>
      createGitHubRuntime({
        ...options,
        operationPacks: { packs: tampered },
      }),
    (error: unknown) =>
      error instanceof OperationPackRefused &&
      error.refusals[0]?.reason === "bundle-digest-mismatch",
  );
  const refusals: string[] = [];
  createGitHubRuntime({
    ...options,
    operationPacks: {
      packs: tampered,
      onRefused: (list) => refusals.push(...list.map(({ reason }) => reason)),
    },
  });
  assert.deepEqual(refusals, ["bundle-digest-mismatch"]);
});

test("a bundle that does not define every declared operation is refused at load", async (t) => {
  const directory = packDirectory(t);
  const signer = publisher();
  const handler = handlerSource("https://api.fixture.example", "");
  writePack(directory, "a-absent", {
    id: "absent",
    operations: [fixtureOperation("big"), fixtureOperation("not-there")],
    handler,
    signer,
  });
  writePack(directory, "b-no-verify", {
    id: "no-verify",
    operations: [fixtureOperation("big", { verify: true })],
    handler,
    signer,
  });
  writePack(directory, "c-throws", {
    id: "throws",
    operations: [fixtureOperation("big")],
    handler: 'throw new Error("at load");',
    signer,
  });
  writePack(directory, "d-no-table", {
    id: "no-table",
    operations: [fixtureOperation("big")],
    handler: "const unrelated = 1;",
    signer,
  });
  writePack(directory, "e-good", {
    id: "good",
    operations: [fixtureOperation("big"), fixtureOperation("host")],
    handler,
    signer,
  });
  const registry = new OperationRegistry(vocabulary);
  const packs = await prepareOperationPacks({
    directory,
    publishers: [{ keyId: signer.keyId, publicKey: signer.publicPem }],
  });
  assert.deepEqual(packs.ready, ["good"]);
  const report = registerOperationPacks(registry, packs);
  assert.deepEqual(
    report.refused.map(({ entry, reason }) => [entry, reason]),
    [
      ["a-absent", "missing-export"],
      ["b-no-verify", "missing-export"],
      ["c-throws", "missing-export"],
      ["d-no-table", "missing-export"],
    ],
  );
  assert.deepEqual(
    registry.catalog().map(({ id }) => id),
    ["pack:good/big", "pack:good/host"],
  );
  // Registration takes only what preparation checked.
  assert.throws(
    () =>
      registerOperationPacks(new OperationRegistry(vocabulary), {
        refused: [],
        ready: [],
      } as unknown as PreparedOperationPacks),
    /prepared first/,
  );
});

test("a live revocation source stops a key's operations without a restart", async (t) => {
  const server = await fixtureServer(t);
  const directory = packDirectory(t);
  const signer = publisher();
  writePack(directory, "fixture", {
    operations: [fixtureOperation("refuse")],
    handler: handlerSource(server.origin, ""),
    signer,
  });
  const revoked = new Set<string>();
  let failing = false;
  const registry = new OperationRegistry(vocabulary);
  const report = await loadOperationPacks(registry, {
    directory,
    publishers: [{ keyId: signer.keyId, publicKey: signer.publicPem }],
    isRevoked: async (keyId) => {
      if (failing) throw new Error("revocation source down");
      return revoked.has(keyId);
    },
  });
  assert.deepEqual(report.refused, []);
  const conflict = { state: "failed", outputs: {}, diagnosticCode: "conflict" };
  const denied = { state: "failed", outputs: {}, diagnosticCode: "denied" };
  assert.deepEqual(await direct({ registry }, "refuse"), conflict);
  revoked.add(signer.keyId);
  assert.deepEqual(await direct({ registry }, "refuse"), denied);
  revoked.clear();
  assert.deepEqual(await direct({ registry }, "refuse"), conflict);
  // A source that cannot answer revokes.
  failing = true;
  assert.deepEqual(await direct({ registry }, "refuse"), denied);
  // Revoked before load: refused like a statically revoked key.
  const again = await loadOperationPacks(new OperationRegistry(vocabulary), {
    directory,
    publishers: [{ keyId: signer.keyId, publicKey: signer.publicPem }],
    isRevoked: () => true,
  });
  assert.deepEqual(
    again.refused.map(({ reason }) => reason),
    ["publisher-revoked"],
  );
});

test("a revocation file is re-read on its interval and fails closed", (t) => {
  const directory = packDirectory(t);
  const path = join(directory, "revoked.txt");
  let now = 0;
  const isRevoked = revocationList(path, { refreshMs: 1000, now: () => now });
  // Missing: every key is revoked.
  assert.equal(isRevoked("fixture-publisher"), true);
  writeFileSync(path, "# withdrawn keys\nold-key\n\n");
  // Not re-read inside the interval.
  now = 500;
  assert.equal(isRevoked("fixture-publisher"), true);
  now = 1000;
  assert.equal(isRevoked("fixture-publisher"), false);
  assert.equal(isRevoked("old-key"), true);
  writeFileSync(path, "old-key\nfixture-publisher # compromised\n");
  now = 1500;
  assert.equal(isRevoked("fixture-publisher"), false);
  now = 2000;
  assert.equal(isRevoked("fixture-publisher"), true);
  // Anything but key ids: fail closed.
  writeFileSync(path, "not a key id!\n");
  now = 3000;
  assert.equal(isRevoked("other-key"), true);
  const defaults = revocationList(path);
  assert.equal(defaults("other-key"), true);
});

test("a global cap bounds concurrent sandboxes and refuses what waits too long", async (t) => {
  const limiter = new OperationPackLimiter({
    maxConcurrent: 1,
    queueTimeoutMs: 200,
    maxQueued: 1,
  });
  const setup = await loaded(
    t,
    () => [
      fixtureOperation("hang", { limits: { timeoutMs: 1500 } }),
      fixtureOperation("refuse"),
    ],
    { concurrency: limiter },
  );
  assert.deepEqual(setup.report.refused, []);
  const unavailable = {
    state: "failed",
    outputs: {},
    diagnosticCode: "unavailable",
  };
  const conflict = { state: "failed", outputs: {}, diagnosticCode: "conflict" };
  // One slot, held by a hanging handler: the next waits 200 ms, then gives up.
  const hanging = direct(setup, "hang");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(limiter.running, 1);
  const started = Date.now();
  const queued = direct(setup, "refuse");
  // The queue holds one: a third is refused at once.
  assert.deepEqual(await direct(setup, "refuse"), unavailable);
  assert.deepEqual(await queued, unavailable);
  assert.ok(Date.now() - started >= 150);
  // Cancelled while waiting.
  const controller = new AbortController();
  const waiting = direct(setup, "refuse", controller.signal);
  controller.abort();
  assert.deepEqual(await waiting, {
    state: "failed",
    outputs: {},
    diagnosticCode: "cancelled",
  });
  assert.deepEqual(await hanging, unavailable);
  assert.equal(limiter.running, 0);
  // A longer wait is served once the slot frees.
  const patient = new OperationPackLimiter({
    maxConcurrent: 1,
    queueTimeoutMs: 10_000,
  });
  const second = await loaded(
    t,
    () => [
      fixtureOperation("hang", { limits: { timeoutMs: 300 } }),
      fixtureOperation("refuse"),
    ],
    { concurrency: patient },
  );
  const first = direct(second, "hang");
  assert.deepEqual(await direct(second, "refuse"), conflict);
  assert.deepEqual(await first, unavailable);
  // Settings instead of a shared limiter; nonsense settings are misconfiguration.
  const configured = await loaded(t, () => [fixtureOperation("refuse")], {
    concurrency: { maxConcurrent: 2 },
  });
  assert.deepEqual(await direct(configured, "refuse"), conflict);
  assert.throws(
    () => new OperationPackLimiter({ maxConcurrent: 0 }),
    /Invalid operation pack concurrency/,
  );
  assert.ok(new OperationPackLimiter().maxConcurrent >= 1);
});

test("an untrusted publisher's operations run in a child process under the permission model", async (t) => {
  const setup = await loaded(
    t,
    (base) => [
      lookupOperation(base),
      fixtureOperation("probe"),
      fixtureOperation("spin", { limits: { timeoutMs: 1000 } }),
      fixtureOperation("big", { limits: { outputBytes: 1024 } }),
      fixtureOperation("hog", { limits: { memoryMb: 16, timeoutMs: 20_000 } }),
      fixtureOperation("stray", { destinations: [base] }),
    ],
    { untrusted: true },
  );
  assert.deepEqual(setup.report.refused, []);
  assert.equal(
    (
      setup.registry.provenance("pack:fixture-pack/lookup", "1.0.0") as {
        isolation: string;
      }
    ).isolation,
    "process",
  );
  // The same capability over IPC: declared origin, injected credential.
  const lookup = await direct(setup, "lookup", undefined, {
    account: "alice",
  });
  assert.deepEqual(lookup.outputs, {
    plan: "pro",
    note: "Bearer [redacted]",
  });
  assert.equal(setup.server.seen[0]!.authorization, `Bearer ${SECRET}`);
  const probe = await direct(setup, "probe");
  assert.equal(probe.state, "complete");
  assert.ok(!String(probe.outputs.note).includes("ESCAPED"));
  assert.ok(String(probe.outputs.note).startsWith("undefined,undefined,"));
  const unavailable = {
    state: "failed",
    outputs: {},
    diagnosticCode: "unavailable",
  };
  assert.deepEqual(await direct(setup, "spin"), unavailable);
  assert.deepEqual(await direct(setup, "big"), unavailable);
  assert.deepEqual(await direct(setup, "hog"), unavailable);
  assert.deepEqual(await direct(setup, "stray"), {
    state: "failed",
    outputs: {},
    diagnosticCode: "denied",
  });
  assert.deepEqual(setup.stray.seen, []);
  // A host may put every publisher in a process.
  const everyone = await loaded(t, () => [fixtureOperation("refuse")], {
    isolation: "process",
  });
  assert.equal(
    (
      everyone.registry.provenance("pack:fixture-pack/refuse", "1.0.0") as {
        isolation: string;
      }
    ).isolation,
    "process",
  );
  assert.deepEqual(await direct(everyone, "refuse"), {
    state: "failed",
    outputs: {},
    diagnosticCode: "conflict",
  });
});

test("the isolation flags deny files, processes and workers, and do not restrict the network", async (t) => {
  const server = await fixtureServer(t);
  const { spawn } = await import("node:child_process");
  const probe = `
    const results = {};
    const code = (reach) => { try { reach(); return "allowed"; } catch (error) { return error.code || error.name; } };
    results.read = code(() => require("node:fs").readFileSync(process.execPath));
    results.write = code(() => require("node:fs").writeFileSync("/tmp/operation-pack-probe", "x"));
    results.spawn = code(() => require("node:child_process").spawnSync(process.execPath, ["-v"]));
    results.worker = code(() => new (require("node:worker_threads").Worker)("1", { eval: true }));
    results.eval = code(() => Function("return 1")());
    const socket = require("node:net").connect(${JSON.stringify(new URL(server.origin).port)}, "127.0.0.1");
    socket.on("connect", () => { results.net = "connected"; socket.destroy(); console.log(JSON.stringify(results)); });
    socket.on("error", (error) => { results.net = error.code; console.log(JSON.stringify(results)); });
  `;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...processIsolationArguments(32), "-e", probe],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("error", reject);
    child.on("exit", () => resolve(text));
  });
  assert.deepEqual(JSON.parse(output), {
    read: "ERR_ACCESS_DENIED",
    write: "ERR_ACCESS_DENIED",
    spawn: "ERR_ACCESS_DENIED",
    worker: "ERR_ACCESS_DENIED",
    eval: "EvalError",
    // Node 22 has no network permission: documented, not relied on.
    net: "connected",
  });
});

test("a host throw at the stack edge never reaches the bundle as a value", async (t) => {
  // Regression: an overflow raised inside the host callback behind
  // ceremony.fetch used to become the fetch promise's rejection value, a
  // host-realm error whose constructor chain gave the bundle that realm's
  // Function. The handler primes the stack to the edge, attempting a fetch at
  // every descent so some call overflows inside the host bridge, then checks
  // every settled value: none may reach a Function outside the sandbox, and
  // none may generate code. Without the guard, worker isolation reports
  // foreign and generated counts above zero.
  const source = `
    const operations = {
      edge: {
        async run(input, ceremony) {
          const seen = [];
          function attempt() {
            try {
              const p = ceremony.fetch({ url: "https://x.example/e" });
              seen.push(p.then(() => undefined, (e) => e));
            } catch (e) {
              seen.push(Promise.resolve(e));
            }
          }
          function edge() { attempt(); edge(); }
          try { edge(); } catch (e) {}
          const values = await Promise.all(seen);
          let foreign = 0, generated = 0;
          for (const v of values) {
            if (!v || (typeof v !== "object" && typeof v !== "function")) continue;
            let maker;
            try { maker = v.constructor.constructor; } catch (e) { continue; }
            if (typeof maker !== "function") continue;
            if (maker !== Function) foreign++;
            try { maker("return 1")(); generated++; } catch (e) {}
          }
          return { outputs: { note: values.length + "," + foreign + "," + generated } };
        },
      },
    };
  `;
  const limiter = new OperationPackLimiter({ maxConcurrent: 2 });
  for (const isolation of ["worker", "process"] as const) {
    const outcome = await runInSandbox({
      source,
      entry: "run",
      operation: "edge",
      input: "null",
      timeoutMs: 30_000,
      memoryMb: 64,
      outputBytes: 64 * 1024,
      signal: AbortSignal.timeout(60_000),
      isolation,
      limiter,
      request: async () => ({
        ok: true,
        text: JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      }),
    });
    assert.equal(outcome.kind, "done", isolation);
    const [attempts, foreign, generated] = JSON.parse(
      (outcome as { text: string }).text,
    )
      .outputs.note.split(",")
      .map(Number);
    // The handler must actually reach the stack edge for the test to mean
    // anything, so it overflows many times.
    assert.ok(attempts > 1000, `${isolation} attempts=${attempts}`);
    assert.equal(
      foreign,
      0,
      `${isolation} reached a Function outside the sandbox`,
    );
    assert.equal(generated, 0, `${isolation} generated code from a string`);
  }
});
