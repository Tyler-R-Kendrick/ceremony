import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  userCodeOf,
  type AwsSetup,
} from "./harness.js";

/*
 * What the host holds, and what the caller sees. The access token, the refresh
 * token, the client secret, the device code and the role credentials are
 * dummy values the double issued, so the sweep looks for the exact strings.
 * Every surface a caller, a model, a log or an operator can read is swept
 * after a ceremony that renews, refreshes, is refused, is denied, signs in a second connection and disconnects; custody
 * and the private half of a handoff are the only places a secret may be, and
 * the sweep proves it can find one there.
 */

const CANARY = "CANARY_PROVIDER_WORDS_91c4";

function secretsOf(setup: AwsSetup): string[] {
  const issued = setup.fixture.issued;
  return [
    ...issued.clientSecrets,
    ...issued.deviceCodes,
    ...issued.accessTokens,
    ...issued.refreshTokens,
    ...issued.roleCredentials.flatMap((role) => [
      role.accessKeyId,
      role.secretAccessKey,
      role.sessionToken,
    ]),
  ];
}

function sweep(
  setup: AwsSetup,
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

test("no surface a caller can read carries a secret, after a ceremony that renews, refreshes, is refused, is denied, signs in a second connection and disconnects", async (t) => {
  const logged = captureConsole(t);
  const setup = await awsSetup(t, {
    double: {
      accessTokenLifetimeSeconds: 1200,
      roleLifetimeMs: 30 * 60_000,
      errorWords: CANARY,
    },
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
  const active = note(
    "active view",
    await setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRefOf(first.polled),
      { accountId: "111122223333", roleName: "ReadOnlyAccess" },
    ),
  ) as { revision: number };

  // What the store holds the moment the role is bound, before any renewal rewrites it.
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

  // Operations that read, and one that is refused.
  note(
    "list accounts",
    await setup.service.invoke(setup.agent, connectionRef, {
      operationRef: "aws-identity-center.list-accounts",
      input: {},
      commandId: "sweep-accounts",
    }),
  );
  const refused = await failure(
    setup.service.invoke(setup.person, connectionRef, {
      operationRef: "aws-identity-center.list-account-roles",
      input: { "aws-account": "777788889999" },
      commandId: "sweep-roles",
    }),
    printed,
  );
  note("refused invoke", refused);
  note(
    "list roles",
    await setup.service.invoke(setup.agent, connectionRef, {
      operationRef: "aws-identity-center.list-account-roles",
      input: { "aws-account": "111122223333" },
      commandId: "sweep-roles-ok",
    }),
  );

  // Renewal, then a refresh grant (the access token lapses at twenty minutes).
  setup.advance(26 * 60_000);
  note(
    "verify with refresh",
    await setup.service.verify(setup.person, connectionRef),
  );
  assert.equal(setup.fixture.counts.refresh, 1);

  // Refusals that carry the provider's words: a role the person does not hold.
  const second = await connectAndApprove(setup, {
    target: { kind: "aws-account", id: "111122223333" },
  });
  const unassigned = await failure(
    setup.service.provideInput(
      setup.person,
      second.connectionRef,
      handoffRefOf(second.polled),
      { accountId: "111122223333", roleName: "BillingAdministrator" },
    ),
    printed,
  );
  note("unassigned role", unassigned);
  assert.equal(unassigned.detail, "aws-identity-center.role.unassigned");

  // A denied approval carries the provider's words in its answer.
  const denying = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: { target: { kind: "aws-account", id: "444455556666" } },
  });
  setup.fixture.deny(userCodeOf(denying));
  setup.advance(6_000);
  note(
    "denied",
    await setup.service.poll(setup.person, connectionRefOf(denying)),
  );

  // Disconnect upstream.
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

  // Every record the host keeps that is not custody.
  for (const ref of [
    connectionRef,
    second.connectionRef,
    connectionRefOf(denying),
  ]) {
    note(`record ${ref}`, await setup.record(ref));
    note(`evidence ${ref}`, await setup.ports.evidence.list(setup.person, ref));
  }
  note("journal", setup.journal);
  note("console", logged);
  note("printed errors", printed);

  sweep(setup, views);
  // Nothing of the provider's own words survives either.
  assert.equal(JSON.stringify(views).includes(CANARY), false);
  assert.equal(JSON.stringify(setup.journal).includes(CANARY), false);
});

test("a refresh answer the client refuses is not printed with the error, cause chain included", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * 60_000 },
  });
  const { connectionRef } = await connectAndChoose(setup);
  // AWS answers the refresh with a token type this client does not support: the
  // answer holds a new token pair, which must not travel with the refusal.
  setup.fixture.answerTokensAs("MAC");
  setup.advance(26 * 60_000);
  const printed: string[] = [];
  const refusal = await failure(
    setup.service.verify(setup.person, connectionRef),
    printed,
  );
  assert.equal(refusal.detail, "aws-identity-center.token.type");
  assert.equal(
    setup.fixture.issued.accessTokens.length,
    2,
    "an answer was issued",
  );
  sweep(setup, [["printed error", printed]]);
});

test("the sweep can find a secret: custody and the private half of a handoff hold them", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, connected } = await connectAndChoose(setup);
  const held = await setup.heldMaterial(connectionRef);
  const held_ = JSON.stringify(held);
  assert.ok(held_.includes(setup.fixture.issued.clientSecrets[0]!));
  assert.ok(held_.includes(setup.fixture.issued.accessTokens[0]!));
  assert.ok(held_.includes(setup.fixture.issued.refreshTokens[0]!));
  assert.ok(
    held_.includes(setup.fixture.issued.roleCredentials[0]!.secretAccessKey),
  );
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
});

test("the provider's own error words are not repeated in an outcome or a refusal", async (t) => {
  const setup = await awsSetup(t, { double: { errorWords: CANARY } });
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
    "aws-identity-center.device.access-denied",
  );
  const other = await awsSetup(t, { double: { errorWords: CANARY } });
  const polled = await connectAndApprove(other);
  const refusals = [
    await failure(
      other.service.provideInput(
        other.person,
        polled.connectionRef,
        handoffRefOf(polled.polled),
        { accountId: "111122223333", roleName: "BillingAdministrator" },
      ),
    ),
  ];
  assert.equal(JSON.stringify([view, refusals]).includes(CANARY), false);
});
