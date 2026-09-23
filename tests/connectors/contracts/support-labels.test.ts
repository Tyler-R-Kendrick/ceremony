import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogEntrySchema,
  checkTargets,
  computeSupportLabel,
  labelForTarget,
  legacyCheckTarget,
  parseSupportEvidence,
  publicCatalogProjection,
  SupportEvidenceError,
  supportEvidenceProblems,
  supportLabelAtLeast,
  supportLabelRules,
  supportLabels,
  type CheckTarget,
  type SupportEvidence,
  type SupportLabel,
} from "../../../src/core/connectors/index.js";

/*
 * The label rules, driven from one table. Each row is a set of entries, an
 * evaluation day and whether the adapter's configuration is present; the
 * expected label is what the rules in `supportLabelRules` must produce. None
 * of these rows can be satisfied by an adapter family: the function never
 * sees one.
 */

const ASOF = Date.parse("2026-09-23T15:30:00.000Z");
const ADAPTER = "openapi-http";

const at = (
  target: CheckTarget,
  recordedAt: string,
  extra: Partial<SupportEvidence> = {},
): SupportEvidence => ({
  adapterId: ADAPTER,
  check: "tests/connectors/openapi/authorize.test.ts",
  target,
  recordedAt,
  ...(target === "attended-live" ? { attendedBy: "A. Reviewer" } : {}),
  ...extra,
});

const cases: Array<{
  name: string;
  entries: SupportEvidence[];
  configured?: boolean;
  label: SupportLabel;
  expired?: number;
  unconfigured?: number;
  future?: number;
}> = [
  { name: "no entry at all", entries: [], label: "unverified" },
  {
    name: "an in-process fixture",
    entries: [at("in-process-fixture", "2026-09-19")],
    label: "fixture",
  },
  {
    name: "a local double outranks a fixture",
    entries: [
      at("in-process-fixture", "2026-09-19"),
      at("local-double", "2026-09-10"),
    ],
    label: "local",
  },
  {
    name: "a recorded live run, configured",
    entries: [
      at("local-double", "2026-09-10"),
      at("recorded-live", "2026-09-01"),
    ],
    label: "live",
  },
  {
    name: "an attended certification, configured",
    entries: [
      at("recorded-live", "2026-09-01"),
      at("attended-live", "2026-08-01"),
    ],
    label: "certified",
  },
  {
    name: "live evidence without its configuration is not admissible",
    entries: [
      at("local-double", "2026-09-10"),
      at("recorded-live", "2026-09-01"),
    ],
    configured: false,
    label: "local",
    unconfigured: 1,
  },
  {
    name: "a certification without its configuration falls to what remains",
    entries: [at("attended-live", "2026-09-01")],
    configured: false,
    label: "unverified",
    unconfigured: 1,
  },
  {
    name: "a live run exactly 90 days old is still fresh",
    entries: [at("recorded-live", "2026-06-25")],
    label: "live",
  },
  {
    name: "a live run 91 days old has expired",
    entries: [
      at("recorded-live", "2026-06-24"),
      at("in-process-fixture", "2026-09-01"),
    ],
    label: "fixture",
    expired: 1,
  },
  {
    name: "a certification 180 days old is fresh, 181 is not",
    entries: [at("attended-live", "2026-03-27")],
    label: "certified",
  },
  {
    name: "an expired certification is not quietly relabelled live",
    entries: [at("attended-live", "2026-03-26")],
    label: "unverified",
    expired: 1,
  },
  {
    name: "local evidence lasts a year and a day no longer",
    entries: [
      at("local-double", "2025-09-22"),
      at("in-process-fixture", "2025-09-23"),
    ],
    label: "fixture",
    expired: 1,
  },
  {
    name: "an entry dated after the evaluation day is not evidence",
    entries: [at("local-double", "2026-09-24")],
    label: "unverified",
    future: 1,
  },
  {
    name: "an entry recorded on the evaluation day counts",
    entries: [at("local-double", "2026-09-23")],
    label: "local",
  },
  {
    name: "another adapter's entry is ignored",
    entries: [at("attended-live", "2026-09-01", { adapterId: "nango" })],
    label: "unverified",
  },
];

for (const row of cases)
  test(`support label: ${row.name}`, () => {
    const result = computeSupportLabel(ADAPTER, row.entries, {
      asOf: ASOF,
      configured: row.configured ?? true,
    });
    assert.equal(result.label, row.label);
    assert.equal(result.expired.length, row.expired ?? 0, "expired");
    assert.equal(
      result.unconfigured.length,
      row.unconfigured ?? 0,
      "unconfigured",
    );
    assert.equal(result.future.length, row.future ?? 0, "future");
    if (row.label === "unverified") assert.equal(result.basis, undefined);
    else assert.equal(labelForTarget(result.basis!.target), row.label);
  });

test("the basis shown is the most recent entry earning the label", () => {
  const result = computeSupportLabel(
    ADAPTER,
    [
      at("local-double", "2026-09-01", { check: "tests/a.test.ts" }),
      at("local-double", "2026-09-20", { check: "tests/b.test.ts" }),
      at("local-double", "2026-09-10", { check: "tests/c.test.ts" }),
    ],
    { asOf: ASOF, configured: true },
  );
  assert.equal(result.basis?.check, "tests/b.test.ts");
});

test("the rule table is total, ordered and the only source of the ladder", () => {
  // Every target earns exactly one label, in the same order as the labels.
  assert.deepEqual(
    checkTargets.map((target) => labelForTarget(target)),
    supportLabels.slice(1),
  );
  for (const label of supportLabels.slice(1) as Array<
    Exclude<SupportLabel, "unverified">
  >)
    assert.ok(supportLabelRules[label].freshForDays > 0);
  assert.equal(supportLabelRules.live.needsConfiguration, true);
  assert.equal(supportLabelRules.certified.needsConfiguration, true);
  assert.equal(supportLabelRules.local.needsConfiguration, false);
  assert.ok(supportLabelAtLeast("certified", "live"));
  assert.ok(supportLabelAtLeast("local", "local"));
  assert.ok(!supportLabelAtLeast("fixture", "local"));
  assert.ok(!supportLabelAtLeast("unverified", "fixture"));
});

test("a legacy evidence level maps to the weakest target it could mean", () => {
  assert.equal(legacyCheckTarget("not-tested"), undefined);
  assert.equal(legacyCheckTarget("unit"), "in-process-fixture");
  assert.equal(legacyCheckTarget("protocol-fixture"), "in-process-fixture");
  assert.equal(legacyCheckTarget("local-integration"), "local-double");
  assert.equal(legacyCheckTarget("browser-integration"), "local-double");
  assert.equal(legacyCheckTarget("live-authorized"), "recorded-live");
  assert.equal(legacyCheckTarget("deployed-authorized"), "recorded-live");
});

const good = {
  adapterId: "catalog-http",
  check: "tests/connectors/provider-catalog/oauth.test.ts",
  target: "local-double",
  recordedAt: "2026-09-23",
};

test("evidence validation refuses malformed entries, each by name", () => {
  const malformed: Array<[string, unknown]> = [
    ["not an object", "local-double"],
    ["unknown key", { ...good, level: "live" }],
    ["unknown target", { ...good, target: "vendor-certified" }],
    ["missing date", { ...good, recordedAt: undefined }],
    ["not a calendar day", { ...good, recordedAt: "2026-02-30" }],
    ["timestamp, not a day", { ...good, recordedAt: "2026-09-23T00:00:00Z" }],
    [
      "path leaving the repository",
      { ...good, check: "tests/../../etc/passwd" },
    ],
    ["absolute path", { ...good, check: "/etc/passwd" }],
    ["URL as a check", { ...good, check: "https://vendor.example/report" }],
    ["file URL", { ...good, check: "file:///etc/passwd" }],
    ["upper-case adapter id", { ...good, adapterId: "Catalog-HTTP" }],
    ["control character in notes", { ...good, notes: "ok\u0007" }],
    [
      "attended certification with nobody attending",
      { ...good, target: "attended-live" },
    ],
    [
      "an attendee on an unattended run",
      { ...good, target: "recorded-live", attendedBy: "A. Reviewer" },
    ],
  ];
  for (const [name, raw] of malformed) {
    const problems = supportEvidenceProblems([good, raw], { asOf: ASOF });
    assert.equal(problems.length, 1, name);
    assert.match(problems[0]!, /^evidence\[1\]: /, name);
  }
  assert.deepEqual(supportEvidenceProblems([good], { asOf: ASOF }), []);
  assert.deepEqual(
    supportEvidenceProblems(
      [{ ...good, check: "ledger:PROVIDER-CATALOG/PCAT-01" }],
      { asOf: ASOF },
    ),
    [],
    "a named check is admissible",
  );
});

test("evidence validation refuses a future date and refuses the whole list", () => {
  const future = { ...good, recordedAt: "2026-09-24" };
  assert.deepEqual(supportEvidenceProblems([future], { asOf: ASOF }), [
    "evidence[0]: catalog-http tests/connectors/provider-catalog/oauth.test.ts is dated 2026-09-24, after 2026-09-23",
  ]);
  assert.throws(
    () => parseSupportEvidence([good, future], { asOf: ASOF }),
    (error: unknown) =>
      error instanceof SupportEvidenceError && error.problems.length === 1,
  );
  assert.equal(parseSupportEvidence([good], { asOf: ASOF }).length, 1);
});

const catalogRow = {
  id: "openapi-http",
  ecosystem: "openapi",
  service: "openapi",
  displayName: "OpenAPI (HTTP)",
  description: "Generic OpenAPI adapter.",
  support: "fixture",
  custody: ["host-owned"],
  runtimes: ["hosted-server"],
  authentication: [],
  configuration: [],
  capabilities: [],
  evidence: "not-tested",
  group: "openapi",
};

test("a catalog entry carries its label through the public projection", () => {
  const entry = catalogEntrySchema.parse({
    ...catalogRow,
    supportLabel: "local",
  });
  assert.equal(publicCatalogProjection(entry).supportLabel, "local");
  const unlabelled = catalogEntrySchema.parse(catalogRow);
  assert.equal("supportLabel" in publicCatalogProjection(unlabelled), false);
});

test("only a provider-backed catalog entry may carry a live label", () => {
  for (const support of ["fixture", "catalog-only"] as const)
    for (const supportLabel of ["live", "certified"] as const)
      assert.throws(
        () =>
          catalogEntrySchema.parse({ ...catalogRow, support, supportLabel }),
        /Only a provider-backed entry carries a live support label/,
        `${support}/${supportLabel}`,
      );
  assert.throws(
    () =>
      catalogEntrySchema.parse({
        ...catalogRow,
        support: "unconfigured",
        supportLabel: "live",
        configuration: [
          {
            name: "API_TOKEN",
            required: true,
            classification: "secret",
            present: false,
          },
        ],
      }),
    /Only a provider-backed entry carries a live support label/,
  );
  assert.equal(
    catalogEntrySchema.parse({
      ...catalogRow,
      support: "provider-backed",
      supportLabel: "certified",
    }).supportLabel,
    "certified",
  );
  assert.throws(() =>
    catalogEntrySchema.parse({ ...catalogRow, supportLabel: "gold" }),
  );
});
