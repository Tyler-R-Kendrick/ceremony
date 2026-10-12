import { readFileSync } from "node:fs";
import { guard } from "./scripts/stryker-guard.mjs";

const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);

const vercel = "src/server/connectors/providers/vercel-account";
const aws = "src/server/connectors/providers/aws-identity-center";
const lease = "src/server/connectors/providers/vercel/credentials.ts";

/*
 * Mutation over the account sign-in decisions.
 *
 * Whole files, not guards, for the modules that decide who a connection is
 * for and when a held session is used: the choice after approval, the
 * renewal rules, the lease the Vercel Connect management leg takes, and the
 * checks that keep a bearer on the host it was approved for. Everything else
 * in the two adapters is wire description (zod shapes and fixed error codes)
 * that the double tests already pin member by member, and mutating it would
 * report survivors that say nothing about a decision.
 *
 * Two kinds of mutant are expected to survive and are not counted as escaped
 * guards: the wording of a message and the `limitations` text of a capability
 * row, which no test is for, and the layered duplicate checks the adapters
 * keep on purpose (a destination is checked again at the call after the
 * binding approved it). Each survivor of a decision is named in the report
 * rather than excused here.
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
    ...guard(lease, "const lease =", 18),
    ...guard(lease, "A leased token is renewed before it is read", 3),
    `${aws}/selection.ts`,
    `${aws}/refresh.ts`,
    `${aws}/material.ts`,
  ],
  tap: {
    ...base.tap,
    testFiles: [
      "tests/connectors/vercel-account/*.test.ts",
      "tests/connectors/aws-identity-center/*.test.ts",
    ],
  },
  jsonReporter: { fileName: "artifacts/accounts-mutation/mutation.json" },
  htmlReporter: { fileName: "artifacts/accounts-mutation/index.html" },
};
