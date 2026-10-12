import assert from "node:assert/strict";
import test from "node:test";
import type { PersonSeed as AwsPerson } from "./doubles/aws-identity-center.js";
import {
  awsSetup,
  connectAndApprove as awsApprove,
} from "./aws-identity-center/harness.js";
import {
  accountSetup,
  alice as vercelAlice,
  connectAndApprove as vercelApprove,
  START_TIME,
} from "./vercel-account/harness.js";

/*
 * Names the provider chose are shown to a person who is about to type one of
 * them. Control characters and bidirectional controls are replaced before they
 * are shown: a name that renders as another is the way to be picked by mistake.
 */

const RLO = "‮";
const BIDI = /[‪-‮⁦-⁩‎‏؜]/u;

test("an AWS account name with bidirectional controls is shown without them", async (t) => {
  const person: AwsPerson = {
    id: "alice",
    accounts: [
      {
        accountId: "111122223333",
        accountName: `Prod${RLO}nimdA‏⁦`,
        roles: ["ReadOnlyAccess"],
      },
      { accountId: "444455556666", accountName: "Sandbox", roles: ["Power"] },
    ],
  };
  const setup = await awsSetup(t, { people: [person] });
  const { polled } = await awsApprove(setup);
  const instructions = (polled as { presentation?: { instructions?: string } })
    .presentation?.instructions;
  assert.ok(instructions, "a choice was asked for");
  assert.match(instructions, /111122223333/);
  assert.match(instructions, /Prod/);
  assert.doesNotMatch(instructions, BIDI);
});

test("a Vercel team slug with bidirectional controls is shown without them", async (t) => {
  const person = {
    ...vercelAlice,
    teams: [
      {
        id: "team_dummy_acme",
        slug: `acme${RLO}gnp.‏`,
        createdAt: START_TIME - 30 * 86_400_000,
      },
      {
        id: "team_dummy_labs",
        slug: "labs",
        createdAt: START_TIME - 20 * 86_400_000,
      },
    ],
  };
  const setup = await accountSetup(t, { people: [person] });
  const { polled } = await vercelApprove(setup);
  const instructions = (polled as { presentation?: { instructions?: string } })
    .presentation?.instructions;
  assert.ok(instructions, "a choice was asked for");
  assert.match(instructions, /team_dummy_acme/);
  assert.doesNotMatch(instructions, BIDI);
});
