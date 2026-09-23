import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { test } from "node:test";
import {
  collectSupportEvidence,
  labelFor,
  type AdapterFacts,
  type Ledger,
} from "../../../scripts/connector-support-matrix.js";
import {
  CertificationRefused,
  runAttendedCertification,
  type AttendantPrompt,
  type CertificationFlowPlan,
} from "../../../src/server/connectors/attended-harness.js";
import {
  certificationProblems,
  certifierKeyId,
  digestOf,
  isProviderOrigin,
  signCertification,
  type AttendedCertification,
  type Certifiers,
  type UnsignedCertification,
} from "../../../src/server/connectors/certification.js";
import type { CeremonyResult } from "../../../src/server/browser-driver.js";

/*
 * Attended certification records and the harness that writes them, without a
 * browser: what a record must carry, every reason the ledger validator
 * refuses one (a rehearsal first among them), and how the harness turns a
 * declined or failed step into no record at all. The end-to-end rehearsal
 * against the auth double is tests/attended-certification.e2e.test.ts.
 */

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function certifier(name = "Ada Attendant") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const entry = {
    keyId: certifierKeyId(publicKey),
    name,
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
  return { privateKey, entry, list: { certifiers: [entry] } as Certifiers };
}

const transcript = [
  { step: "attend", kind: "attestation", outcome: "confirmed" },
  { step: "outcome", kind: "attestation", outcome: "confirmed" },
] as const;

function unsigned(
  overrides: Partial<UnsignedCertification> = {},
): UnsignedCertification {
  return {
    kind: "attended-certification",
    schemaVersion: 1,
    id: "2026-10-02-northwind-catalog-connect-abc123",
    adapterId: "catalog-http",
    definition: `sha256:${"a".repeat(64)}`,
    provider: { name: "Northwind", origins: ["https://auth.northwind.com"] },
    flow: "catalog-connect",
    rehearsal: false,
    attendedBy: "Ada Attendant",
    recordedAt: "2026-10-02",
    commit: COMMIT,
    transcript: { digest: digestOf(transcript), steps: 2, humanSteps: 2 },
    outcome: "completed",
    ...overrides,
  };
}

const catalog: AdapterFacts = {
  id: "catalog-http",
  factory: "createCatalogHttpAdapter",
  module: "src/server/connectors/formats/provider-catalog/index.ts",
  ecosystem: "provider-catalog",
  adapterVersion: "1.0.0",
  runtime: "hosted-server",
  service: "provider-catalog",
  displayName: "Provider catalog",
  support: "fixture",
  evidenceScope: "definition",
  custody: [],
  profiles: [],
  configuration: [],
  rows: {},
};
const vendor: AdapterFacts = {
  ...catalog,
  id: "vendor-http",
  module: "src/server/connectors/providers/vendor/index.ts",
  evidenceScope: "adapter",
};

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

test("a signed record from a listed certifier verifies and earns an attended entry", () => {
  const { privateKey, list } = certifier();
  const record = signCertification(unsigned(), privateKey);
  assert.deepEqual(certificationProblems(record, list, { asOf: NOW }), []);
  const collection = collectSupportEvidence([], [catalog], {
    today: NOW,
    certifications: [{ source: "certifications/x.json", record, transcript }],
    certifiers: list,
  });
  assert.deepEqual(collection.refused, []);
  const [entry] = collection.entries;
  assert.equal(entry?.target, "attended-live");
  assert.equal(entry?.check, `attended:${record.id}`);
  assert.equal(entry?.attendedBy, "Ada Attendant");
  assert.equal(entry?.definition, record.definition);
  // The published row is the generic code path, so even a certification
  // leaves it below live; the definition it names is what it certifies.
  assert.equal(labelFor(catalog, collection).label, "unverified");
});

test("a single-provider adapter's certification labels it certified", () => {
  const { privateKey, list } = certifier();
  const { definition: _definition, ...rest } = unsigned({
    adapterId: "vendor-http",
  });
  void _definition;
  const record = signCertification(rest, privateKey);
  const collection = collectSupportEvidence([], [vendor], {
    today: NOW,
    certifications: [{ source: "certifications/v.json", record, transcript }],
    certifiers: list,
  });
  assert.deepEqual(collection.refused, []);
  assert.equal(labelFor(vendor, collection).label, "certified");
});

test("a rehearsal is refused as certification however well it is signed", () => {
  const { privateKey, list } = certifier();
  const record = signCertification(unsigned({ rehearsal: true }), privateKey);
  assert.deepEqual(certificationProblems(record, list, { asOf: NOW }), [
    "a rehearsal against local doubles is not a certification",
  ]);
  const collection = collectSupportEvidence([], [catalog], {
    today: NOW,
    certifications: [{ source: "certifications/r.json", record, transcript }],
    certifiers: list,
  });
  assert.equal(collection.entries.length, 0);
  assert.match(collection.refused[0]!, /^certifications\/r\.json: .*rehearsal/);
});

test("every other reason a record is refused is named", () => {
  const { privateKey, list, entry } = certifier();
  const signed = (overrides: Partial<UnsignedCertification> = {}) =>
    signCertification(unsigned(overrides), privateKey);
  const problems = (record: unknown, certifiers = list) =>
    certificationProblems(record, certifiers, { asOf: NOW }).join(" | ");

  const tampered = {
    ...signed(),
    provider: { name: "Northwind", origins: ["https://auth.other.com"] },
  } satisfies AttendedCertification;
  assert.match(problems(tampered), /signature does not verify/);
  assert.match(problems(signed(), { certifiers: [] }), /no certifier holds/);
  assert.match(
    problems(signed(), { certifiers: [{ ...entry, name: "Somebody Else" }] }),
    /not the person the certifier list gives this key/,
  );
  const other = certifier().entry;
  assert.match(
    problems(signed(), {
      certifiers: [{ ...entry, publicKey: other.publicKey }],
    }),
    /does not match its identifier/,
  );
  assert.match(
    problems(signed(), {
      certifiers: [{ ...entry, publicKey: "A".repeat(60) }],
    }),
    /does not parse/,
  );
  assert.match(
    problems(signed({ recordedAt: "2026-10-03" })),
    /after 2026-10-02/,
  );
  for (const origin of [
    "http://auth.northwind.com",
    "https://127.0.0.1:8443",
    "https://localhost",
    "https://auth.northwind.test",
    "https://provider.example",
  ])
    assert.match(
      problems(signed({ provider: { name: "X", origins: [origin] } })),
      /local or reserved stand-in/,
      origin,
    );
  assert.match(problems({ ...signed(), extra: true }), /Unrecognized key/);

  // The validator adds what only it can know.
  const collection = collectSupportEvidence([], [catalog], {
    today: NOW,
    certifications: [
      {
        source: "certifications/no-definition.json",
        record: (() => {
          const { definition: _definition, ...rest } = unsigned();
          void _definition;
          return signCertification(rest, privateKey);
        })(),
        transcript,
      },
      {
        source: "certifications/no-transcript.json",
        record: signed(),
      },
      {
        source: "certifications/other-transcript.json",
        record: signed(),
        transcript: [transcript[0]],
      },
      {
        source: "certifications/unknown-adapter.json",
        record: signed({ adapterId: "nobody-http" }),
        transcript,
      },
    ],
    certifiers: list,
  });
  assert.equal(collection.entries.length, 0);
  for (const [index, pattern] of [
    [0, /names its definition/],
    [1, /transcript is missing/],
    [2, /does not match the signed digest/],
    [3, /no constructible adapter is named nobody-http/],
  ] as const)
    assert.match(collection.refused[index]!, pattern);
});

test("an attended entry typed into a ledger is refused: only a signed record is an attendance", () => {
  const collection = collectSupportEvidence(
    [
      ledger({
        supportEvidence: [
          {
            adapterId: "vendor-http",
            // A real file, so the attendance itself is what is refused.
            check: "tests/connectors/contracts/certification.test.ts",
            target: "attended-live",
            recordedAt: "2026-10-01",
            attendedBy: "Ada Attendant",
          },
        ],
      }),
    ],
    [vendor],
    { today: NOW },
  );
  assert.equal(collection.entries.length, 0);
  assert.match(
    collection.refused[0]!,
    /enters only as a signed record under certifications/,
  );
});

test("provider origins: public HTTPS names only", () => {
  assert.equal(isProviderOrigin("https://auth.northwind.com"), true);
  for (const origin of [
    "https://auth.northwind.com/path",
    "not a url",
    "https://intranet",
    "https://[::1]",
    "https://svc.internal",
    "https://printer.local",
    "https://example",
  ])
    assert.equal(isProviderOrigin(origin), false, origin);
});

/** A driver result, value-free, as `runCeremony` returns it. */
const driven = (status: CeremonyResult["status"] = "completed") =>
  ({
    status,
    steps: 3,
    handoffs: 0,
    transcript: [{ path: "https://auth.northwind.com/signin", action: "fill" }],
  }) as unknown as CeremonyResult;

function plan(
  steps: CertificationFlowPlan["steps"],
  overrides: Partial<CertificationFlowPlan> = {},
): CertificationFlowPlan {
  return {
    flow: "registration",
    adapterId: "vendor-http",
    provider: { name: "Northwind", origins: ["https://auth.northwind.com"] },
    rehearsal: false,
    steps,
    ...overrides,
  };
}

function attendant(answers: (prompt: AttendantPrompt) => boolean = () => true) {
  const asked: AttendantPrompt[] = [];
  return {
    asked,
    attendant: {
      name: "Ada Attendant",
      confirm: async (prompt: AttendantPrompt) => {
        asked.push(prompt);
        return answers(prompt);
      },
    },
  };
}

async function run(
  flow: CertificationFlowPlan,
  who = attendant(),
  key: KeyObject = certifier().privateKey,
) {
  return runAttendedCertification({
    plan: flow,
    attendant: who.attendant,
    commit: COMMIT,
    signingKey: key,
    now: () => NOW,
    nonce: "abc123",
  });
}

test("the harness asks the attendant at every human step and signs a value-free record", async () => {
  const who = attendant();
  const { privateKey, list } = certifier();
  const outcome = await run(
    plan([
      {
        id: "sign-up",
        kind: "driver",
        confirm: "The account exists.",
        run: async (human) => {
          // The driver hands one step to a person.
          assert.equal(
            await human.request({
              reason: "choice",
              surface: "provider-browser",
              recipient: "initiating-subject",
              path: "https://auth.northwind.com/signup",
              attempt: 1,
            }),
            "completed",
          );
          return driven();
        },
      },
      { id: "configure", kind: "service", run: async () => true },
      { id: "dashboard", kind: "human", question: "The dashboard shows it." },
    ]),
    who,
    privateKey,
  );
  if (outcome.status !== "certified")
    return assert.fail(`expected a certification, got ${outcome.status}`);
  assert.deepEqual(
    who.asked.map((prompt) => `${prompt.kind}:${prompt.step}`),
    [
      "attestation:attend",
      "driver:sign-up",
      "driver:sign-up",
      "human:dashboard",
      "attestation:outcome",
    ],
  );
  assert.equal(outcome.record.transcript.humanSteps, 5);
  assert.equal(outcome.record.transcript.steps, 5);
  assert.equal(outcome.record.transcript.digest, digestOf(outcome.transcript));
  assert.equal(outcome.record.commit, COMMIT);
  assert.equal(outcome.record.recordedAt, "2026-10-02");
  assert.equal(outcome.record.id, "2026-10-02-northwind-registration-abc123");
  assert.deepEqual(
    certificationProblems(outcome.record, list, { asOf: NOW }),
    [],
  );
  // The driver's transcript is digested, never carried.
  assert.equal(JSON.stringify(outcome).includes("/signin"), false);
});

test("a declined confirmation, a failed step or a refused driver leaves no record", async () => {
  const completes = {
    id: "sign-up",
    kind: "driver" as const,
    confirm: "The account exists.",
    run: async () => driven(),
  };
  const cases: Array<
    [CertificationFlowPlan, (prompt: AttendantPrompt) => boolean, string]
  > = [
    [plan([completes]), (prompt) => prompt.step !== "attend", "attend"],
    [plan([completes]), (prompt) => prompt.step !== "sign-up", "sign-up"],
    [plan([completes]), (prompt) => prompt.step !== "outcome", "outcome"],
    [
      plan([{ ...completes, run: async () => driven("blocked") }]),
      () => true,
      "sign-up",
    ],
    [
      plan([
        {
          ...completes,
          run: async () => {
            throw new Error("browser gone");
          },
        },
      ]),
      () => true,
      "sign-up",
    ],
    [
      plan([
        {
          id: "configure",
          kind: "service",
          run: async () => {
            throw new Error("upstream refused");
          },
        },
      ]),
      () => true,
      "configure",
    ],
    [
      plan([{ id: "configure", kind: "service", run: async () => false }]),
      () => true,
      "configure",
    ],
    [
      plan([{ id: "look", kind: "human", question: "It is there." }]),
      (prompt) => prompt.step !== "look",
      "look",
    ],
    [
      plan([
        {
          ...completes,
          run: async (human) => {
            const answer = await human.request({
              reason: "passkey",
              surface: "provider-browser",
              recipient: "initiating-subject",
              path: "https://auth.northwind.com/passkey",
              attempt: 1,
            });
            return driven(answer === "completed" ? "completed" : "blocked");
          },
        },
      ]),
      (prompt) => prompt.kind !== "driver",
      "sign-up",
    ],
  ];
  for (const [flow, answers, step] of cases) {
    const outcome = await run(flow, attendant(answers));
    assert.equal(outcome.status, "failed", step);
    if (outcome.status === "failed") assert.equal(outcome.step, step);
  }
});

test("a run that names a stand-in is refused before it starts unless it is a rehearsal", async () => {
  const stand = plan(
    [{ id: "look", kind: "human", question: "It is there." }],
    {
      provider: { name: "Double", origins: ["http://127.0.0.1:4100"] },
    },
  );
  const who = attendant();
  await assert.rejects(run(stand, who), CertificationRefused);
  assert.equal(who.asked.length, 0, "nobody was asked to attend");
  const rehearsed = await run({ ...stand, rehearsal: true });
  assert.equal(rehearsed.status, "rehearsed");
  for (const [commit, nonce] of [
    ["HEAD", "abc123"],
    [COMMIT, "x"],
  ] as const)
    await assert.rejects(
      runAttendedCertification({
        plan: { ...stand, rehearsal: true },
        attendant: attendant().attendant,
        commit,
        signingKey: certifier().privateKey,
        now: () => NOW,
        nonce,
      }),
      CertificationRefused,
    );
});
