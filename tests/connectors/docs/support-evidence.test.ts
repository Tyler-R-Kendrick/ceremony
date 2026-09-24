import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSupportEvidence,
  generate,
  labelFor,
  loadLedgers,
  type AdapterFacts,
  type Ledger,
} from "../../../scripts/connector-support-matrix.js";
import { recordedSupportEvidence } from "../../../src/server/connectors/recorded-evidence.js";
import { generateKeyPairSync } from "node:crypto";
import {
  certifierKeyId,
  digestOf,
  signCertification,
} from "../../../src/server/connectors/certification.js";

/*
 * The ledger side of evidence-derived support labels: what a ledger may say,
 * what is refused, how undated work items become dated entries, and that the
 * published matrix and the runtime's generated copy are exactly what the
 * ledgers produce today.
 */

const TODAY = Date.parse("2026-09-23T12:00:00.000Z");

function ledgerDirectory(t: TestContext, ledgers: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "ceremony-ledgers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(ledgers))
    writeFileSync(join(directory, name), JSON.stringify(body));
  return directory;
}

const adapter = (
  id: string,
  module: string,
  configuration: AdapterFacts["configuration"] = [],
): AdapterFacts => ({
  id,
  factory: "createAdapter",
  module,
  ecosystem: "openapi",
  adapterVersion: "1.0.0",
  runtime: "hosted-server",
  service: id,
  displayName: id,
  support: "fixture",
  evidenceScope: "adapter",
  custody: [],
  profiles: [],
  configuration,
  rows: {},
});

const openapi = adapter(
  "openapi-http",
  "src/server/connectors/formats/openapi/index.ts",
);
const vendor = adapter(
  "vendor-http",
  "src/server/connectors/providers/vendor/index.ts",
  [{ name: "VENDOR_KEY", required: true, classification: "secret" }],
);

const ledger = (overrides: Partial<Ledger>): Ledger => ({
  swarm: "TEST",
  recordedAt: "2026-09-19",
  workItems: [],
  supportEvidence: [],
  unmet: [],
  externalEffectsPerformed: [],
  securityFindings: [],
  ...overrides,
});

const item = (
  id: string,
  evidenceLevel: string,
  files: string[],
): Ledger["workItems"][number] => ({
  id,
  status: "implemented",
  files,
  tests: [],
  acceptanceIds: [],
  evidenceLevel,
  sourceProfileIds: [],
  limitations: [],
  notes: "",
});

test("a ledger that records its external effects structurally is read, not dropped", (t) => {
  // Regression: AUTOMATION and BINDINGS recorded `externalEffectsPerformed`
  // as objects, the matrix schema accepted strings only, both ledgers were
  // discarded whole, and camel-kamelet, dapr and open-service-broker read
  // `not-recorded` although their ledger names their files and tests.
  const directory = ledgerDirectory(t, {
    "BINDINGS.json": {
      swarm: "BINDINGS",
      workItems: [
        item("BIND-02", "protocol-fixture", [
          "src/server/connectors/providers/dapr/adapter.ts",
        ]),
      ],
      externalEffectsPerformed: [
        { kind: "none", statement: "No sidecar outside loopback." },
      ],
    },
  });
  const { ledgers, problems } = loadLedgers(directory);
  assert.deepEqual(problems, []);
  assert.equal(ledgers[0]?.swarm, "BINDINGS");
  assert.equal(ledgers[0]?.workItems[0]?.id, "BIND-02");
});

test("a ledger that does not match the shape is reported with the field that failed", (t) => {
  const directory = ledgerDirectory(t, {
    "BROKEN.json": { swarm: "BROKEN", workItems: [{ id: "BR-01" }] },
  });
  const { ledgers, problems } = loadLedgers(directory);
  assert.equal(ledgers.length, 0);
  assert.match(problems[0]!, /^ledger\/BROKEN\.json: .*workItems\.0\.status/);
});

test("explicit entries are admitted only when well formed, dated, about a known adapter and citing a real file", () => {
  const exists = (path: string) =>
    path === "tests/connectors/openapi/authorize.test.ts";
  const valid = {
    adapterId: "openapi-http",
    check: "tests/connectors/openapi/authorize.test.ts",
    target: "local-double",
    recordedAt: "2026-09-23",
  };
  const collection = collectSupportEvidence(
    [
      ledger({
        supportEvidence: [
          valid,
          { ...valid, target: "vendor-certified" },
          { ...valid, recordedAt: "2026-09-24" },
          { ...valid, adapterId: "nobody-http" },
          { ...valid, check: "tests/connectors/openapi/missing.test.ts" },
          { ...valid, target: "attended-live" },
        ],
      }),
    ],
    [openapi],
    { today: TODAY, exists },
  );
  assert.deepEqual(
    collection.entries.map((entry) => entry.check),
    ["tests/connectors/openapi/authorize.test.ts"],
  );
  assert.equal(collection.refused.length, 5);
  for (const [index, pattern] of [
    [1, /target/],
    [2, /dated 2026-09-24, after 2026-09-23/],
    [3, /no constructible adapter is named nobody-http/],
    [4, /missing\.test\.ts does not exist/],
    [5, /names who attended/],
  ] as const)
    assert.ok(
      collection.refused.some(
        (line) =>
          line.startsWith(`ledger TEST: evidence[${index}]: `) &&
          pattern.test(line),
      ),
      `evidence[${index}]`,
    );
  assert.equal(collection.asOf, "2026-09-23");
});

test("undated work items become dated entries by their ledger's day, never above an in-process fixture", () => {
  const collection = collectSupportEvidence(
    [
      ledger({
        swarm: "HTTP",
        workItems: [
          item("HTTP-04", "protocol-fixture", [
            "src/server/connectors/formats/openapi/adapter.ts",
          ]),
          item("HTTP-09", "local-integration", [
            "src/server/connectors/formats/openapi/invoke.ts",
          ]),
          item("HTTP-10", "not-tested", [
            "src/server/connectors/formats/openapi/export.ts",
          ]),
          item("HTTP-11", "unit", ["src/server/elsewhere/file.ts"]),
        ],
      }),
      ledger({
        swarm: "UNDATED",
        recordedAt: undefined,
        workItems: [
          item("UN-01", "local-integration", [
            "src/server/connectors/providers/vendor/adapter.ts",
          ]),
        ],
      }),
    ],
    [openapi, vendor],
    { today: TODAY, exists: () => true },
  );
  assert.deepEqual(collection.refused, []);
  assert.deepEqual(
    collection.entries.map((entry) => [
      entry.adapterId,
      entry.check,
      entry.target,
      entry.recordedAt,
    ]),
    [
      [
        "openapi-http",
        "ledger:HTTP/HTTP-04",
        "in-process-fixture",
        "2026-09-19",
      ],
      [
        "openapi-http",
        "ledger:HTTP/HTTP-09",
        "in-process-fixture",
        "2026-09-19",
      ],
    ],
  );
  assert.deepEqual(collection.notes, [
    "ledger UNDATED has no `recordedAt`, so its work items earn no support label",
  ]);
  // Regression: a legacy local-integration item used to earn `local`.
  assert.equal(labelFor(openapi, collection).label, "fixture");
  assert.equal(labelFor(vendor, collection).label, "unverified");
});

test("a ledger cannot type a live run, and cites a file rather than a named check", () => {
  // Regression: a hand-typed recorded-live entry was admitted, and a check
  // containing ":" skipped the file-exists test, so this one earned `live`.
  const typed = {
    adapterId: "vendor-http",
    check: "typed:anything",
    target: "recorded-live",
    recordedAt: "2026-09-20",
  };
  const collection = collectSupportEvidence(
    [
      ledger({
        supportEvidence: [
          typed,
          { ...typed, check: "tests/connectors/openapi/authorize.test.ts" },
          { ...typed, target: "local-double" },
          { ...typed, check: "ledger:HTTP/HTTP-04", target: "local-double" },
        ],
      }),
    ],
    [vendor],
    { today: TODAY, exists: () => true },
  );
  assert.deepEqual(collection.entries, []);
  assert.equal(labelFor(vendor, collection).label, "unverified");
  for (const [index, pattern] of [
    [0, /not a named check \(typed:anything\)/],
    [1, /a live run is a deployment's own evidence/],
    [2, /not a named check/],
    [3, /not a named check \(ledger:HTTP\/HTTP-04\)/],
  ] as const)
    assert.ok(
      collection.refused.some(
        (line) =>
          line.startsWith(`ledger TEST: evidence[${index}]: `) &&
          pattern.test(line),
      ),
      `evidence[${index}]`,
    );
});

test("a legacy live evidence level is refused, not counted", () => {
  const collection = collectSupportEvidence(
    [
      ledger({
        workItems: [
          item("TEST-01", "live-authorized", [
            "src/server/connectors/formats/openapi/adapter.ts",
          ]),
          item("TEST-02", "deployed-authorized", [
            "src/server/connectors/formats/openapi/adapter.ts",
          ]),
        ],
      }),
    ],
    [openapi],
    { today: TODAY, exists: () => true },
  );
  assert.equal(collection.entries.length, 0);
  assert.equal(collection.refused.length, 2);
  for (const line of collection.refused)
    assert.match(
      line,
      /a live level needs an explicit, dated, attributed entry/,
    );
});

test("a ledger dated in the future is refused rather than earning a label", () => {
  const collection = collectSupportEvidence(
    [
      ledger({
        recordedAt: "2026-10-01",
        workItems: [
          item("TEST-01", "unit", [
            "src/server/connectors/formats/openapi/adapter.ts",
          ]),
        ],
      }),
    ],
    [openapi],
    { today: TODAY, exists: () => true },
  );
  assert.equal(collection.entries.length, 0);
  assert.match(collection.refused[0]!, /TEST-01: .*dated 2026-10-01/);
});

test("published labels are evaluated as of the newest recorded day, and live evidence needs configuration", () => {
  // Live evidence reaches the generator only as a signed certification.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const certifiers = {
    certifiers: [
      {
        keyId: certifierKeyId(publicKey),
        name: "A. Reviewer",
        publicKey: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      },
    ],
  };
  const transcript = [
    { step: "attend", kind: "attestation", outcome: "confirmed" },
    { step: "outcome", kind: "attestation", outcome: "confirmed" },
  ];
  const record = signCertification(
    {
      kind: "attended-certification",
      schemaVersion: 1,
      id: "2026-09-20-vendor-registration-abc123",
      adapterId: "vendor-http",
      provider: { name: "Vendor", origins: ["https://auth.vendor.com"] },
      flow: "registration",
      rehearsal: false,
      attendedBy: "A. Reviewer",
      recordedAt: "2026-09-20",
      commit: "0123456789abcdef0123456789abcdef01234567",
      transcript: { digest: digestOf(transcript), steps: 2, humanSteps: 2 },
      outcome: "completed",
    },
    privateKey,
  );
  const collection = collectSupportEvidence([], [openapi, vendor], {
    today: TODAY,
    certifications: [{ source: "certifications/v.json", record, transcript }],
    certifiers,
  });
  assert.deepEqual(collection.refused, []);
  assert.equal(collection.asOf, "2026-09-20");
  // The matrix measures with no configuration present, so an adapter that
  // requires configuration cannot present live evidence there.
  const result = labelFor(vendor, collection);
  assert.equal(result.label, "unverified");
  assert.equal(result.unconfigured.length, 1);
});

test("the published matrix and the runtime's recorded evidence are exactly what the ledgers generate", async () => {
  const generated = await generate();
  for (const file of generated)
    assert.equal(
      readFileSync(file.path, "utf8"),
      file.content,
      `${file.path} is stale: run npm run docs:connectors`,
    );
  const matrix = generated.find((file) =>
    file.path.endsWith("connector-support-matrix.md"),
  )!.content;
  const labelOf = (id: string) => {
    const row = matrix
      .split("\n")
      .find(
        (line) =>
          line.startsWith(`| \`${id}\``) && line.includes("hosted-server"),
      );
    assert.ok(row, id);
    return row.split("|")[5]!.trim();
  };
  // The generic OpenAPI and catalog code paths are exercised against local
  // doubles by the suites their ledgers cite: above the family default,
  // never live, and marked as describing the code path, not a definition.
  assert.equal(labelOf("openapi-http"), "local (code path)");
  assert.equal(labelOf("catalog-http"), "local (code path)");
  // So are the remote MCP and Microsoft custom-connector adapters, which
  // run whatever server or connector a person imported.
  assert.equal(labelOf("mcp-remote"), "local (code path)");
  assert.equal(labelOf("microsoft-custom-connector"), "local (code path)");
  // The adapters whose ledgers used to be dropped now have a label, earned
  // by their own suites against loopback stand-ins.
  for (const id of ["camel-kamelet", "dapr", "open-service-broker"])
    assert.equal(labelOf(id), "local", id);
  // Two Supabase profiles never reach a stand-in server end to end (a fake
  // MCP client port, a fake query port), so the backfill leaves them at
  // `fixture` rather than rounding them up with their siblings.
  for (const id of ["supabase-mcp", "supabase-wrappers"])
    assert.equal(labelOf(id), "fixture", id);
  // A `local` label rests on an explicit, dated entry that cites the test
  // file which ran against the stand-in, never on a legacy work-item level.
  for (const line of matrix.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (!line.startsWith("| `") || cells.length < 6) continue;
    const basis = matrix
      .split("\n")
      .find(
        (other) =>
          other.startsWith(`| ${cells[1]} `) &&
          other.includes("(local-double,"),
      );
    if (cells[5]?.startsWith("local"))
      assert.match(basis ?? "", /`tests\/[^`]+\.test\.ts` \(local-double, /);
  }
  assert.equal(matrix.includes("not-recorded"), false);
  for (const line of matrix.split("\n"))
    if (line.startsWith("| `") && line.includes("hosted-server"))
      assert.ok(
        !/^(live|certified)\b/.test(line.split("|")[5]!.trim()),
        line.slice(0, 60),
      );
  // Every explicit entry the runtime ships cites a check a reader can open.
  for (const entry of recordedSupportEvidence)
    if (!entry.check.includes(":"))
      assert.doesNotThrow(
        () => readFileSync(entry.check),
        `${entry.adapterId}: ${entry.check}`,
      );
});
