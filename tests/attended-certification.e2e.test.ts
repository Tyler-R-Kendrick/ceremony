import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectSupportEvidence,
  loadCertifications,
  readAdapters,
  type AdapterFacts,
} from "../scripts/connector-support-matrix.js";
import {
  launchManagedBrowser,
  type ManagedBrowser,
} from "../src/server/browser-backends.js";
import {
  runAttendedCertification,
  type AttendantPrompt,
} from "../src/server/connectors/attended-harness.js";
import {
  certificationProblems,
  certifierKeyId,
  type CertificationFlow,
} from "../src/server/connectors/certification.js";
import { rehearsalPlan } from "./certification/rehearsal.js";

/*
 * The attended certification harness end to end, as a rehearsal: each of the
 * three flows runs through the real driver, the production heuristic
 * interpreter and real Chromium against the local auth double, with a
 * scripted attendant confirming every step a person is asked about. Each run
 * signs a record with a key the (temporary) certifier list holds, over a
 * transcript that matches, for a known adapter, so its signature verifies
 * and the ledger validator must refuse it for what it is: a rehearsal
 * against local stand-ins. Then the command-line script does the same for
 * one flow, answering its prompts on stdin.
 *
 * Nothing here reaches a real provider. Every origin is loopback and every
 * credential synthetic.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

let browser: ManagedBrowser;
let adapters: AdapterFacts[];

before(async () => {
  browser = await launchManagedBrowser("chromium");
  ({ adapters } = await readAdapters());
});

after(async () => {
  await browser?.dispose();
});

function certifierFiles(directory: string, name: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const list = {
    certifiers: [
      {
        keyId: certifierKeyId(publicKey),
        name,
        publicKey: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      },
    ],
  };
  // Beside the records, never among them: every JSON file there is one.
  mkdirSync(join(directory, "keys"));
  const certifiers = join(directory, "keys", "certifiers.json");
  writeFileSync(certifiers, JSON.stringify(list));
  const keyPath = join(directory, "keys", "attendant.pem");
  writeFileSync(
    keyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    { mode: 0o600 },
  );
  return { privateKey, list, certifiers, keyPath };
}

/** What the validator makes of whatever a run wrote to `directory`. */
function validate(directory: string, certifiers: string) {
  const loaded = loadCertifications(directory, certifiers);
  assert.deepEqual(loaded.problems, []);
  return collectSupportEvidence([], adapters, {
    today: Date.now(),
    certifications: loaded.files,
    certifiers: loaded.certifiers,
  });
}

for (const flow of [
  "registration",
  "stitched-chain",
  "catalog-connect",
] as const satisfies readonly CertificationFlow[])
  test(`REHEARSAL: the ${flow} flow runs attended against the auth double, and its record is refused as certification`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ceremony-rehearsal-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const { privateKey, list, certifiers } = certifierFiles(
      directory,
      "Rehearsal Attendant",
    );
    const rehearsal = await rehearsalPlan(flow, browser);
    t.after(() => rehearsal.close());
    const asked: AttendantPrompt[] = [];
    const run = await runAttendedCertification({
      plan: rehearsal.plan,
      attendant: {
        name: "Rehearsal Attendant",
        confirm: async (prompt) => {
          asked.push(prompt);
          return true;
        },
      },
      commit: COMMIT,
      signingKey: privateKey,
      now: Date.now,
      nonce: "rehearsal1",
    });
    if (run.status !== "rehearsed")
      return assert.fail(
        run.status === "failed"
          ? `${run.step} ${run.outcome}`
          : "a rehearsal plan produced a certification",
      );

    // Every step a person was needed for was put to the attendant, and a
    // driver handoff (registration's region choice, a sign-in's nothing)
    // shows up as its own confirmation.
    assert.ok(asked.some((prompt) => prompt.step === "attend"));
    assert.ok(asked.some((prompt) => prompt.step === "outcome"));
    if (flow === "registration")
      assert.ok(
        asked.some(
          (prompt) =>
            prompt.kind === "driver" &&
            prompt.step === "register" &&
            prompt.path?.startsWith(rehearsal.plan.provider.origins[0]!),
        ),
        "the region choice the driver handed over was confirmed by the attendant",
      );
    for (const prompt of asked)
      assert.equal(prompt.path?.includes("?") ?? false, false, prompt.path);
    assert.equal(run.record.rehearsal, true);
    assert.equal(run.record.flow, flow);
    assert.equal(run.record.transcript.humanSteps, asked.length);

    writeFileSync(
      join(directory, `${run.record.id}.json`),
      JSON.stringify(run.record),
    );
    writeFileSync(
      join(directory, `${run.record.id}.transcript.json`),
      JSON.stringify(run.transcript),
    );
    // Signed by a listed key, over a matching transcript, for a known
    // adapter: what is wrong with it is that it is a rehearsal, against
    // stand-ins, and nothing else.
    assert.deepEqual(
      certificationProblems(run.record, list, { asOf: Date.now() }).map(
        (problem) => problem.replace(/ \(\d+ of \d+\)$/, ""),
      ),
      [
        "a provider origin is a local or reserved stand-in",
        "a rehearsal against local doubles is not a certification",
      ],
    );
    const collection = validate(directory, certifiers);
    assert.equal(collection.entries.length, 0);
    assert.equal(collection.refused.length, 1);
    assert.match(
      collection.refused[0]!,
      /; a rehearsal against local doubles is not a certification$/,
    );
  });

test("REHEARSAL-CLI: the script drives a flow, takes each confirmation from the terminal and writes a record the validator refuses", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ceremony-rehearsal-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { certifiers, keyPath } = certifierFiles(directory, "CLI Attendant");
  const out = join(directory, "out");
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(root, "scripts/certify-attended.ts"),
      "--flow",
      "registration",
      "--target",
      "rehearsal",
      "--attended-by",
      "CLI Attendant",
      "--key",
      keyPath,
      "--out",
      out,
    ],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    // One answer per prompt, as a person would type it.
    for (const _ of String(chunk).matchAll(/Confirm\? \[y\/N\] /g))
      child.stdin.write("y\n");
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const code = await new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /Rehearsal record written/);
  assert.match(stdout, /refuses it as certification/);
  const written = readdirSync(out).sort();
  assert.equal(written.length, 2);
  assert.ok(written.some((name) => name.endsWith(".transcript.json")));
  const collection = validate(out, certifiers);
  assert.equal(collection.entries.length, 0);
  assert.match(
    collection.refused[0]!,
    /a rehearsal against local doubles is not a certification$/,
  );
});

test("the script refuses to write a rehearsal among certifications, or to start a real run unattended", async () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.CEREMONY_LIVE_AUTHORIZED;
  delete env.CEREMONY_LIVE_ATTENDED;
  const runScript = (args: string[]) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(root, "scripts/certify-attended.ts"), ...args],
        { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  const base = ["--flow", "registration", "--attended-by", "Someone"];
  const intoLedger = await runScript([
    ...base,
    "--target",
    "rehearsal",
    "--out",
    join(
      root,
      "docs/implementation-evidence/connector-interoperability/certifications",
    ),
  ]);
  assert.equal(intoLedger.code, 2);
  assert.match(intoLedger.stderr, /never written among certifications/);
  const unattended = await runScript([
    ...base,
    "--target",
    join(root, "tests/certification/rehearsal.ts"),
  ]);
  assert.equal(unattended.code, 2);
  assert.match(unattended.stderr, /authorized-attended-run-required/);
});
