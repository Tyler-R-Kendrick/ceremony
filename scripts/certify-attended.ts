import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchManagedBrowser } from "../src/server/browser-backends.js";
import {
  runAttendedCertification,
  type Attendant,
  type AttendantPrompt,
  type CertificationFlowPlan,
} from "../src/server/connectors/attended-harness.js";
import {
  certificationFlows,
  certifierKeyId,
  type CertificationFlow,
} from "../src/server/connectors/certification.js";

/*
 * Attended certification of one flow against one provider. See
 * docs/certification.md.
 *
 *   certify-attended --keygen <private-key.pem> --attended-by "<name>"
 *   certify-attended --flow <registration|stitched-chain|catalog-connect>
 *                    --target <rehearsal | path/to/target.ts>
 *                    --attended-by "<name>" [--key <private-key.pem>] [--out <dir>]
 *
 * A target module exports `certificationPlan(flow)`, returning the flow's
 * plan for one real provider and a `close`. `rehearsal` runs the same three
 * flows against the local auth double in headless Chromium instead; what it
 * writes is marked a rehearsal and is never accepted as certification.
 *
 * A real run refuses to start unless the checkout is clean (the record names
 * the commit that ran), `CEREMONY_LIVE_AUTHORIZED=true` and
 * `CEREMONY_LIVE_ATTENDED=true` are set, a person is at the terminal, and
 * the attendant's key is supplied. Every confirmation is asked on the
 * terminal; nothing typed there is recorded. Provider sign-in, MFA and
 * consent stay the person's.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const certificationsDirectory = join(
  root,
  "docs/implementation-evidence/connector-interoperability/certifications",
);

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Confirmations on the terminal, one line each; only `y` or `yes` confirms. */
function terminalAttendant(name: string): Attendant & { close(): void } {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const pending = lines[Symbol.asyncIterator]();
  return {
    name,
    async confirm(prompt: AttendantPrompt) {
      process.stdout.write(
        `\n[${prompt.kind}: ${prompt.step}] ${prompt.question}\nConfirm? [y/N] `,
      );
      const next = await pending.next();
      const answer = next.done ? "" : String(next.value).trim().toLowerCase();
      const confirmed = answer === "y" || answer === "yes";
      process.stdout.write(confirmed ? "confirmed\n" : "not confirmed\n");
      return confirmed;
    },
    close: () => lines.close(),
  };
}

function keygen(path: string, name: string) {
  if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  // Only the public half is printed, for a reviewed change to certifiers.json.
  console.log(
    JSON.stringify(
      {
        keyId: certifierKeyId(publicKey),
        name,
        publicKey: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      },
      null,
      2,
    ),
  );
}

async function planFor(
  flow: CertificationFlow,
  target: string,
): Promise<{ plan: CertificationFlowPlan; close(): Promise<void> }> {
  if (target === "rehearsal") {
    const browser = await launchManagedBrowser("chromium");
    const { rehearsalPlan } =
      await import("../tests/certification/rehearsal.js");
    try {
      const rehearsal = await rehearsalPlan(flow, browser);
      return {
        plan: rehearsal.plan,
        close: async () => {
          await rehearsal.close();
          await browser.dispose();
        },
      };
    } catch (error) {
      await browser.dispose();
      throw error;
    }
  }
  const module = (await import(pathToFileURL(resolve(target)).href)) as {
    certificationPlan?: (
      flow: CertificationFlow,
    ) => Promise<{ plan: CertificationFlowPlan; close(): Promise<void> }>;
  };
  if (typeof module.certificationPlan !== "function")
    throw new Error("target-must-export-certificationPlan");
  return module.certificationPlan(flow);
}

export async function main(argv: readonly string[]): Promise<number> {
  const attendedBy = argument(argv, "attended-by");
  const keygenPath = argument(argv, "keygen");
  if (keygenPath) {
    if (!attendedBy) throw new Error("attended-by-required");
    keygen(keygenPath, attendedBy);
    return 0;
  }
  const flow = argument(argv, "flow") as CertificationFlow | undefined;
  const target = argument(argv, "target");
  if (!flow || !(certificationFlows as readonly string[]).includes(flow))
    throw new Error(`flow-required: one of ${certificationFlows.join(", ")}`);
  if (!target) throw new Error("target-required: rehearsal or a module path");
  if (!attendedBy) throw new Error("attended-by-required");
  const rehearsal = target === "rehearsal";
  const keyPath = argument(argv, "key");
  if (!rehearsal) {
    if (
      process.env.CEREMONY_LIVE_AUTHORIZED !== "true" ||
      process.env.CEREMONY_LIVE_ATTENDED !== "true"
    )
      throw new Error("authorized-attended-run-required");
    if (!process.stdin.isTTY) throw new Error("attending-person-required");
    if (!keyPath) throw new Error("attendant-key-required");
    if (git(["status", "--porcelain"]))
      throw new Error("clean-checkout-required");
  }
  // A rehearsal without a key signs with a throwaway one no certifier holds.
  const signingKey: KeyObject = keyPath
    ? createPrivateKey(readFileSync(keyPath))
    : generateKeyPairSync("ed25519").privateKey;
  const out = resolve(
    argument(argv, "out") ??
      (rehearsal
        ? join(root, "artifacts/certification-rehearsal")
        : certificationsDirectory),
  );
  if (rehearsal && out === resolve(certificationsDirectory))
    throw new Error("a rehearsal is never written among certifications");

  const commit = git(["rev-parse", "HEAD"]);
  const attendant = terminalAttendant(attendedBy);
  const { plan, close } = await planFor(flow, target);
  try {
    if (plan.rehearsal !== rehearsal)
      throw new Error("target-and-plan-disagree-about-rehearsal");
    const run = await runAttendedCertification({
      plan,
      attendant,
      commit,
      signingKey,
      now: Date.now,
      nonce: randomBytes(6).toString("hex"),
    });
    if (run.status === "failed") {
      console.log(
        `\nNo record: step ${run.step} ${run.outcome}. Nothing was written.`,
      );
      return 1;
    }
    mkdirSync(out, { recursive: true });
    const recordPath = join(out, `${run.record.id}.json`);
    writeFileSync(recordPath, `${JSON.stringify(run.record, null, 2)}\n`);
    writeFileSync(
      join(out, `${run.record.id}.transcript.json`),
      `${JSON.stringify(run.transcript, null, 2)}\n`,
    );
    console.log(
      `\n${run.status === "rehearsed" ? "Rehearsal" : "Certification"} record written: ${recordPath}`,
    );
    if (run.status === "rehearsed")
      console.log(
        "This is a rehearsal against local doubles. The ledger validator refuses it as certification.",
      );
    return 0;
  } finally {
    attendant.close();
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`certify-attended: ${(error as Error).message}`);
      process.exit(2);
    },
  );
