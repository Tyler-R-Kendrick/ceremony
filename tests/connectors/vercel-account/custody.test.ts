import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { ensureFresh } from "../../../src/server/connectors/providers/vercel-account/session.js";
import {
  accountSetup,
  alice,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  userCodeOf,
  type AccountSetup,
} from "./harness.js";

/*
 * What the host holds, and what the caller sees. The access token, the
 * refresh token, the ID token and the device code are dummy values the double
 * issued, so the sweep looks for the exact strings. Every surface a caller, a
 * model, a log or an operator can read is swept after a ceremony that
 * refreshes, is refused, is denied and disconnects; custody and the private
 * half of a handoff are the only places a secret may be, and the sweep proves
 * it can find one there. The person's email address is swept for too: it is
 * personal data the account calls never need to repeat.
 */

const CANARY = "CANARY_PROVIDER_WORDS_5e1d";

function secretsOf(setup: AccountSetup): string[] {
  const issued = setup.fixture.issued;
  return [
    ...issued.deviceCodes,
    ...issued.accessTokens,
    ...issued.refreshTokens,
    ...issued.idTokens,
  ];
}

function sweep(
  setup: AccountSetup,
  surfaces: Array<[label: string, value: unknown]>,
  extra: string[] = [],
) {
  const secrets = [...secretsOf(setup), ...extra];
  assert.ok(secrets.length > 5, "the ceremony issued secrets to look for");
  for (const [label, value] of surfaces) {
    const text = JSON.stringify(value) ?? "";
    for (const secret of secrets)
      assert.equal(
        text.includes(secret),
        false,
        `${label} contains an issued secret`,
      );
  }
}

/** Collects what console methods were asked to print, to be swept with the rest. */
function captureConsole(t: TestContext) {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  return lines;
}

/**
 * A refusal as a caller sees it. What the error prints when it is inspected or
 * logged, cause chain and hidden members included, goes to `printed` so it is
 * swept with the rest.
 */
async function failure(work: Promise<unknown>, printed: string[] = []) {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof ConnectorError);
    printed.push(inspect(error, { depth: null, showHidden: true }));
    return {
      code: error.code,
      detail: error.detail,
      message: error.message,
      status: error.status,
    };
  }
  throw new Error("expected a refusal");
}

test("no surface a caller can read carries a secret, after a ceremony that refreshes, is refused, is denied and disconnects", async (t) => {
  const logged = captureConsole(t);
  const setup = await accountSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, errorWords: CANARY },
    revoke: true,
  });
  const views: Array<[string, unknown]> = [];
  const printed: string[] = [];
  const note = (label: string, value: unknown) => {
    views.push([label, value]);
    return value;
  };

  const first = await connectAndApprove(setup);
  note("connect view", first.connected);
  note("choose view", first.polled);
  const connectionRef = first.connectionRef;
  // A refusal that carries the provider's words: a team the person is not in.
  const unknown = await failure(
    setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRefOf(first.polled),
      { team: "someone-elses" },
    ),
    printed,
  );
  note("unknown team", unknown);
  assert.equal(unknown.detail, "vercel-account.team.unknown");
  const active = note(
    "active view",
    await setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRefOf(first.polled),
      { team: "acme" },
    ),
  ) as { revision: number };

  // What the store holds the moment the team is bound, before any refresh rewrites it.
  note("record when bound", await setup.record(connectionRef));
  note(
    "evidence when bound",
    await setup.ports.evidence.list(setup.person, connectionRef),
  );

  // The same words a person would see, and the agent's narrower projection.
  note(
    "status (human)",
    await setup.service.status(setup.person, connectionRef),
  );
  note(
    "status (agent)",
    await setup.service.status(setup.agent, connectionRef),
  );

  // Operations that read.
  note(
    "get user",
    await setup.service.invoke(setup.agent, connectionRef, {
      operationRef: "vercel-account.get-user",
      input: {},
      commandId: "sweep-user",
    }),
  );
  note(
    "list teams",
    await setup.service.invoke(setup.agent, connectionRef, {
      operationRef: "vercel-account.list-teams",
      input: {},
      commandId: "sweep-teams",
    }),
  );
  note(
    "refused invoke",
    await failure(
      setup.service.invoke(setup.person, connectionRef, {
        operationRef: "vercel-account.get-user",
        input: { extra: "x" },
        commandId: "sweep-refused",
      }),
      printed,
    ),
  );

  // A refresh grant (the access token lapses at twenty minutes).
  setup.advance(19 * 60_000);
  note(
    "verify with refresh",
    await setup.service.verify(setup.person, connectionRef),
  );
  assert.equal(setup.fixture.counts.refresh, 1);

  // A denied approval carries the provider's words in its answer.
  const denying = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: { target: { kind: "vercel-team", id: "team_dummy_labs" } },
  });
  setup.fixture.deny(userCodeOf(denying));
  setup.advance(6_000);
  note(
    "denied",
    await setup.service.poll(setup.person, connectionRefOf(denying)),
  );

  // Disconnect upstream: both tokens are presented to the revocation endpoint.
  const disconnected = await setup.service.disconnect(
    setup.person,
    connectionRef,
    {
      expectedRevision:
        (await setup.record(connectionRef)).revision ?? active.revision,
      scope: "upstream",
    },
  );
  note("disconnect result", disconnected);
  assert.equal(setup.fixture.counts.revoke > 0, true);

  // Every record the host keeps that is not custody.
  for (const ref of [connectionRef, connectionRefOf(denying)]) {
    note(`record ${ref}`, await setup.record(ref));
    note(`evidence ${ref}`, await setup.ports.evidence.list(setup.person, ref));
  }
  note("journal", setup.journal);
  note("console", logged);
  note("printed errors", printed);

  sweep(setup, views, [alice.email!]);
  // Nothing of the provider's own words survives either.
  assert.equal(JSON.stringify(views).includes(CANARY), false);
  assert.equal(JSON.stringify(setup.journal).includes(CANARY), false);
});

test("a refresh answer the client refuses is not printed with the error, cause chain included", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  // Vercel answers the refresh with a token type this client does not support:
  // the answer holds a new token pair, and the library keeps the answer on its error.
  setup.fixture.answerTokensAs("mac");
  setup.advance(59 * 60_000);
  const ctx = await setup.adapterContext(connectionRef);
  const printed: string[] = [];
  const refusal = await failure(
    ensureFresh(ctx, ctx.connection!.credentialRef!, {}),
    printed,
  );
  assert.equal(refusal.code, "expired");
  assert.equal(refusal.detail, "vercel-account.session.refresh-unknown");
  assert.equal(
    setup.fixture.issued.accessTokens.length,
    2,
    "an answer was issued",
  );
  sweep(setup, [["printed error", printed]]);
});

test("the sweep can find a secret: custody and the private half of a handoff hold them", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef, connected } = await connectAndChoose(setup);
  const held = await setup.heldMaterial(connectionRef);
  const text = JSON.stringify(held);
  assert.ok(text.includes(setup.fixture.issued.accessTokens[0]!));
  assert.ok(text.includes(setup.fixture.issued.refreshTokens[0]!));
  // The device code lives in the handoff's private half, which only its owner can present.
  const record = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(connected),
  );
  assert.equal(
    record?.private["deviceCode"],
    setup.fixture.issued.deviceCodes[0],
  );
  assert.throws(() => sweep(setup, [["custody", held]]));
  assert.throws(() => sweep(setup, [["handoff", record]]));
  // The ID token Vercel issued with the openid scope is not kept at all.
  assert.equal(setup.fixture.issued.idTokens.length, 1);
  assert.equal(text.includes(setup.fixture.issued.idTokens[0]!), false);
});

test("the provider's own error words are not repeated in an outcome or a refusal", async (t) => {
  const setup = await accountSetup(t, { double: { errorWords: CANARY } });
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const connectionRef = connectionRefOf(connected);
  setup.fixture.deny(userCodeOf(connected));
  setup.advance(6_000);
  const view = await setup.service.poll(setup.person, connectionRef);
  assert.equal(
    (view as { lastOutcome?: string }).lastOutcome,
    "oauth.device.access-denied",
  );
  const other = await accountSetup(t, { double: { errorWords: CANARY } });
  const polled = await connectAndApprove(other);
  const refusals = [
    await failure(
      other.service.provideInput(
        other.person,
        polled.connectionRef,
        handoffRefOf(polled.polled),
        { team: "someone-elses" },
      ),
    ),
  ];
  assert.equal(JSON.stringify([view, refusals]).includes(CANARY), false);
});

test("an account read says who signed in and which teams, and never the email or the token", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const user = (await setup.service.invoke(setup.agent, connectionRef, {
    operationRef: "vercel-account.get-user",
    input: {},
    commandId: "who",
  })) as { state: string; output: unknown };
  assert.equal(user.state, "complete");
  assert.deepEqual(user.output, {
    user: { id: alice.id, username: "alice", name: "Alice Example" },
  });
  const teams = (await setup.service.invoke(setup.agent, connectionRef, {
    operationRef: "vercel-account.list-teams",
    input: {},
    commandId: "which",
  })) as { output: { teams: Array<{ id: string; bound: boolean }> } };
  // The third team is the person's, but the binding does not permit it.
  assert.deepEqual(
    teams.output.teams.map((team) => [team.id, team.bound]),
    [
      ["team_dummy_labs", false],
      ["team_dummy_acme", true],
    ],
  );
  assert.equal(JSON.stringify([user, teams]).includes(alice.email!), false);
});
