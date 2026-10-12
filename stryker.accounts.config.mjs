import { readFileSync } from "node:fs";
import { guard } from "./scripts/stryker-guard.mjs";

const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);

const vercel = "src/server/connectors/providers/vercel-account";
const aws = "src/server/connectors/providers/aws-identity-center";
const lease = "src/server/connectors/providers/vercel/credentials.ts";
const issuerPolicy = `${vercel}/contracts.ts`;

/*
 * Mutation over the account sign-in decisions.
 *
 * Mutated, whole files: in the Vercel account adapter `ceremony.ts`,
 * `session.ts`, `invoke.ts`, `management.ts`, `evidence.ts` and `client.ts`;
 * in the AWS IAM Identity Center adapter `selection.ts`, `refresh.ts` and
 * `material.ts`. Mutated, a guard only: the lease branch and the lease
 * renewal call in the existing Vercel Connect `credentials.ts`, and
 * `vercelAccountIssuerPolicy` in the Vercel account `contracts.ts`.
 *
 * NOT mutated, and so not covered by any score quoted for this config: the
 * AWS `device.ts` (the poll loop, `slow_down`, the replay journal), AWS
 * `client.ts` (the host pin, redirect refusal, timeouts), `portal.ts`,
 * `invoke.ts`, `evidence.ts`, `contracts.ts` and `index.ts`; the rest of the
 * Vercel account `contracts.ts` and `index.ts`; and `bounded-body.ts`. Those
 * are exercised by the double, ceremony, fault and wire suites, not measured
 * here.
 *
 * Whole files, not guards, for the modules that decide who a connection is
 * for and when a held session is used: the choice after approval, the
 * renewal rules, the lease the Vercel Connect management leg takes, and the
 * checks that keep a bearer on the host it was approved for. Everything else
 * is wire description (zod shapes and fixed error codes) that the double
 * tests already pin member by member, and mutating it would report survivors
 * that say nothing about a decision.
 *
 * Two kinds of mutant are expected to survive and are not counted as escaped
 * guards: the wording of a message and the `limitations` text of a capability
 * row, which no test is for, and the layered duplicate checks the adapters
 * keep on purpose (a destination is checked again at the call after the
 * binding approved it). Every survivor of the last recorded run is listed,
 * with a verdict, in docs/implementation-evidence/connector-interoperability/
 * account-mutation-survivors.md.
 */
export default {
  ...base,
  concurrency: 3,
  timeoutMS: 20000,
  mutate: [
    `${vercel}/ceremony.ts`,
    `${vercel}/session.ts`,
    `${vercel}/invoke.ts`,
    `${vercel}/management.ts`,
    `${vercel}/evidence.ts`,
    `${vercel}/client.ts`,
    // The lease branch of the Vercel Connect credential, not the rest of the file.
    ...guard(lease, "const lease =", 26),
    ...guard(lease, "A leased token is renewed before it is read", 3),
    // The pin a host writes for the real Vercel: which origins an issuer may name.
    ...guard(issuerPolicy, "export function vercelAccountIssuerPolicy(", 14),
    `${aws}/selection.ts`,
    `${aws}/refresh.ts`,
    `${aws}/material.ts`,
  ],
  tap: {
    ...base.tap,
    testFiles: [
      "tests/connectors/vercel-account/*.test.ts",
      "tests/connectors/aws-identity-center/*.test.ts",
      // The lease branch of the Vercel Connect credential is also reached by
      // every test that resolves a credential without one.
      "tests/connectors/vercel/*.test.ts",
    ],
  },
  jsonReporter: { fileName: "artifacts/accounts-mutation/mutation.json" },
  htmlReporter: { fileName: "artifacts/accounts-mutation/index.html" },
};
