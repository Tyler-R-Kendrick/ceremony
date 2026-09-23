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
  const live = {
    adapterId: "vendor-http",
    check: "attended:2026-09-20-vendor",
    target: "attended-live",
    recordedAt: "2026-09-20",
    attendedBy: "A. Reviewer",
  };
  const collection = collectSupportEvidence(
    [ledger({ supportEvidence: [live] })],
    [openapi, vendor],
    { today: TODAY, exists: () => false },
  );
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
  // The adapters whose ledgers used to be dropped now have a label.
  for (const id of ["camel-kamelet", "dapr", "open-service-broker"])
    assert.equal(labelOf(id), "fixture", id);
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
