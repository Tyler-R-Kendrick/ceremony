import assert from "node:assert/strict";
import test from "node:test";
import {
  accountSetup,
  connectAndChoose,
  type AccountSetup,
} from "./harness.js";

/*
 * What Vercel reported granting is not a credential, and verifying a live
 * sign-in must not depend on how many scopes were granted. Custody refuses a
 * callback result that contains anything the record holds, so a scope read
 * back out of the record through a `use` callback is refused whenever the
 * grant is a single scope (the result string is the whole member). The
 * reported scopes are kept in the connection's state, which holds no
 * credential, and verify reads them there.
 */

type View = { lifecycle: string; lastOutcome?: string };
const asView = (value: unknown) => value as View;

const verify = async (setup: AccountSetup, connectionRef: string) =>
  asView(await setup.service.verify(setup.person, connectionRef));

const evidenceOf = async (setup: AccountSetup, connectionRef: string) =>
  JSON.stringify(await setup.ports.evidence.list(setup.person, connectionRef));

for (const scopes of [
  ["openid"],
  ["email"],
  ["profile"],
  ["offline_access"],
  ["openid", "email"],
])
  test(`a live sign-in granted ${JSON.stringify(scopes)} verifies, and says what was reported`, async (t) => {
    const setup = await accountSetup(t, { settings: { scopes } });
    const { connectionRef } = await connectAndChoose(setup);
    const before = (await evidenceOf(setup, connectionRef)).length;
    const view = await verify(setup, connectionRef);
    assert.equal(view.lifecycle, "active");
    assert.equal(setup.fixture.counts.refresh, 0, "the token was still live");
    const evidence = await evidenceOf(setup, connectionRef);
    assert.ok(evidence.length > before, "verify recorded new claims");
    assert.ok(
      evidence.split(`"reported":${JSON.stringify(scopes)}`).length >= 3,
      "the sign-in and the verification both name the reported scopes",
    );
  });

test("what verify says was reported is what the sign-in stored, whatever refreshes since", async (t) => {
  const setup = await accountSetup(t, {
    settings: { scopes: ["openid", "offline_access"] },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(59 * 60_000);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 1);
  const evidence = await evidenceOf(setup, connectionRef);
  assert.ok(
    evidence.split('"reported":["openid","offline_access"]').length >= 3,
  );
});
