import assert from "node:assert/strict";
import test from "node:test";
import { accountSetup, connectAndChoose } from "./harness.js";

/*
 * The tests move a clock of their own, starting at a fixed date. The client
 * library validates an ID token against the wall clock, which that clock does
 * not move, so a token the double dated by the test clock expires on the wall
 * clock an hour after the date the tests were written: every sign-in then
 * fails, and the suite passes on the day it was written and on no other.
 */

test("an ID token is valid by the wall clock, whatever the test clock says", async (t) => {
  const setup = await accountSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200 },
  });
  await connectAndChoose(setup);
  const [idToken] = setup.fixture.issued.idTokens;
  assert.ok(idToken, "a sign-in with the openid scope was issued an ID token");
  const claims = JSON.parse(
    Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8"),
  ) as { iat: number; exp: number };
  const real = Math.floor(Date.now() / 1000);
  assert.ok(claims.iat <= real + 5, "not issued in the future");
  assert.ok(claims.exp > real, "not already expired");
  assert.ok(
    claims.exp - claims.iat <= 1200,
    "lives as long as the access token",
  );
});
