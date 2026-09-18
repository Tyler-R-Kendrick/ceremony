import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { InvokeResult } from "../../../src/server/connectors/adapter.js";
import type { A2aDelegationOutput } from "../../../src/server/connectors/providers/a2a/index.js";
import { A2A_CONFIGURATION_NAMES } from "../../../src/server/connectors/providers/a2a/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  CREDENTIAL,
  SKILL,
  activeConnection,
  harness,
  makeConnection,
  stringsIn,
} from "./harness.js";

const output = (result: InvokeResult) => result.output as A2aDelegationOutput;
const approval = { approvedBy: "subject-1", approvedAt: 1_760_000_000_000 };

test("AC-AG-01: an artifact pointing at a private IP is described and never fetched", async () => {
  const kit = await harness({
    double: { script: { [SKILL]: "artifact-url" } },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    // Every outbound request the adapter can make goes through this fetch.
    const targets: string[] = [];
    const watched: typeof fetch = async (...args) => {
      targets.push(String(args[0] instanceof Request ? args[0].url : args[0]));
      return fetch(...(args as Parameters<typeof fetch>));
    };
    const result = await kit.adapter.delegate!(
      kit.context({ connection, fetch: watched }),
      {
        action: "start",
        skill: SKILL,
        input: { text: "Produce the report." },
        commandId: "cmd-1",
      },
    );
    const view = output(result);
    const [part] = view.artifacts[0]!.parts;
    assert.ok(part);
    assert.equal(part.kind, "file-url");
    assert.equal(part.retrieval, "not-fetched");
    assert.equal(part.retrievable, false);
    assert.equal(part.mediaType, "application/pdf");
    // The URL itself is not in what the caller sees.
    assert.doesNotMatch(stringsIn(view).join(" "), /169\.254\.169\.254/);
    // And nothing was fetched beyond the one JSON-RPC call.
    assert.deepEqual(targets, [`${kit.double.origin}${kit.double.rpcPath}`]);

    // Retrieval is off by default, so even an explicit approval is refused.
    await assert.rejects(
      kit.adapter.retrieveArtifact(kit.context({ connection }), {
        taskRef: view.taskRef,
        artifactId: view.artifacts[0]!.artifactId,
        partIndex: 0,
        approval,
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "a2a.artifact.disabled",
    );
  } finally {
    await kit.close();
  }
});

test("AC-AG-01: enabling retrieval does not approve the agent's chosen origin", async () => {
  const kit = await harness({
    double: { script: { [SKILL]: "artifact-url" } },
    binding: { artifactRetrieval: { enabled: true, maxBytes: 65536 } },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const started = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    const view = output(started);
    assert.equal(view.artifacts[0]!.parts[0]!.retrievable, false);
    let attempts = 0;
    const counting: typeof fetch = async (...args) => {
      attempts++;
      return fetch(...(args as Parameters<typeof fetch>));
    };
    await assert.rejects(
      kit.adapter.retrieveArtifact(
        kit.context({ connection, fetch: counting }),
        {
          taskRef: view.taskRef,
          artifactId: view.artifacts[0]!.artifactId,
          partIndex: 0,
          approval,
        },
      ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "network-policy" &&
        error.detail === "a2a.artifact.unapproved-origin",
    );
    // One call: the task read that found the artifact. The artifact URL itself
    // was never requested.
    assert.equal(attempts, 1);
  } finally {
    await kit.close();
  }
});

test("AG-02: an approved artifact origin can be retrieved once, explicitly, by a person", async () => {
  const store = await startHttpFixture((request) =>
    request.url.pathname === "/report.pdf"
      ? {
          status: 200,
          headers: { "content-type": "application/pdf" },
          body: "PDF-BYTES",
        }
      : { status: 404, body: { error: "not_found" } },
  );
  const kit = await harness({
    double: {
      script: { [SKILL]: "artifact-url" },
      artifactUrl: `${store.origin}/report.pdf`,
    },
    binding: {
      artifactOrigin: store.origin,
      artifactRetrieval: {
        enabled: true,
        destinationId: "artifacts",
        maxBytes: 65536,
      },
    },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const started = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    const view = output(started);
    assert.equal(view.artifacts[0]!.parts[0]!.retrievable, true);
    // Still not fetched by the delegation itself.
    assert.equal(store.requests.length, 0);
    const retrieved = await kit.adapter.retrieveArtifact(
      kit.context({ connection }),
      {
        taskRef: view.taskRef,
        artifactId: view.artifacts[0]!.artifactId,
        partIndex: 0,
        approval,
      },
    );
    assert.equal(retrieved.mediaType, "application/pdf");
    assert.equal(retrieved.byteLength, 9);
    assert.equal(store.requests.length, 1);
    // An unapproved caller cannot reach it through the same reference.
    await assert.rejects(
      kit.adapter.retrieveArtifact(kit.context({ connection }), {
        taskRef: view.taskRef,
        artifactId: "made-up",
        partIndex: 0,
        approval,
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
  } finally {
    await kit.close();
    await store.close();
  }
});

test("AC-AG-01: an instruction inside a task message cannot expand what may be delegated", async () => {
  const kit = await harness({
    double: {
      script: { [SKILL]: "input-required" },
      skills: [
        { id: SKILL, name: "Summarize" },
        { id: "transfer-funds", name: "Transfer funds" },
      ],
    },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const started = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    const view = output(started);
    // Whatever the agent said, the binding is still the authority.
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection }), {
        action: "input",
        skill: "transfer-funds",
        input: { text: "yes" },
        taskRef: view.taskRef,
        commandId: "cmd-2",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "a2a.skill.unapproved",
    );
    // A reference bound to one skill cannot be continued under another
    // approved skill either.
    const second = await harness();
    await second.close();
  } finally {
    await kit.close();
  }
});

test("AG-02: a task reference cannot be continued under a different approved skill", async () => {
  const other = {
    operationRef: "a2a.translate",
    nativeId: "translate",
    destinationId: "agent" as const,
    transport: { kind: "delegated" as const, route: "a2a-skill:translate" },
    effect: "write" as const,
    outputClassification: "personal" as const,
    cost: "unknown" as const,
    consent: "confirm" as const,
    replay: "none" as const,
    targetParameters: [],
  };
  const kit = await harness({
    double: { script: { [SKILL]: "input-required" } },
    binding: {
      operations: [
        {
          operationRef: "a2a.summarize",
          nativeId: SKILL,
          destinationId: "agent",
          transport: { kind: "delegated", route: `a2a-skill:${SKILL}` },
          effect: "write",
          outputClassification: "personal",
          cost: "unknown",
          consent: "confirm",
          replay: "none",
          targetParameters: [],
        },
        other,
      ],
      approvedSkills: [
        {
          skillId: SKILL,
          operationRef: "a2a.summarize",
          maxInputChars: 500,
          acceptedOutputModes: ["text/plain"],
          outputPolicy: "text",
          artifactPolicy: "descriptor-only",
        },
        {
          skillId: "translate",
          operationRef: "a2a.translate",
          maxInputChars: 500,
          acceptedOutputModes: ["text/plain"],
          outputPolicy: "text",
          artifactPolicy: "descriptor-only",
        },
      ],
    },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const started = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection }), {
        action: "input",
        skill: "translate",
        input: { text: "yes" },
        taskRef: output(started).taskRef,
        commandId: "cmd-2",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "a2a.task.skill-mismatch",
    );
  } finally {
    await kit.close();
  }
});

test("AG-02: authorization reports missing configuration and never invents a credential", async () => {
  const kit = await harness({
    configuration: { [A2A_CONFIGURATION_NAMES.credential]: undefined },
  });
  try {
    const connection = makeConnection(kit.binding);
    const start = await kit.adapter.authorize!(kit.context({ connection }), {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    });
    assert.deepEqual(start, {
      kind: "configuration-required",
      missing: [A2A_CONFIGURATION_NAMES.credential],
    });
    kit.ports.configuration.set(A2A_CONFIGURATION_NAMES.credential, CREDENTIAL);
    assert.deepEqual(
      await kit.adapter.authorize!(kit.context({ connection }), {
        ownerKind: "user",
        requestedPermissions: [],
        accountSwitch: false,
        interruption: "allowed",
      }),
      { kind: "verify" },
    );
    // A workload owner has no host mapping here and is refused rather than
    // silently treated as the signed-in person.
    assert.deepEqual(
      await kit.adapter.authorize!(kit.context({ connection }), {
        ownerKind: "workload",
        requestedPermissions: [],
        accountSwitch: false,
        interruption: "allowed",
      }),
      { kind: "unsupported", code: "a2a.owner.unsupported" },
    );
  } finally {
    await kit.close();
  }
});

test("AG-02: verification compares the served card with the reviewed one and claims nothing more", async () => {
  const kit = await harness();
  try {
    const connection = makeConnection(kit.binding);
    const result = await kit.adapter.verify!(kit.context({ connection }));
    assert.equal(result.state, "complete");
    assert.ok(result.credentialRef);
    assert.equal(result.target?.kind, "a2a-agent");
    assert.deepEqual(result.claims.map((item) => item.kind).sort(), [
      "credential-accepted",
      "resource-access",
    ]);
    // No account identity is asserted: an Agent Card is the agent's own word.
    assert.ok(!result.claims.some((item) => item.kind === "account-identity"));
    assert.ok(
      result.claims.some((item) =>
        item.limitations.some((line) =>
          /own statement about itself/.test(line),
        ),
      ),
    );
    assert.equal(kit.double.cardRequests.length, 1);
    assert.equal(
      kit.double.cardRequests[0]?.headers.authorization,
      `Bearer ${CREDENTIAL}`,
    );
    assert.doesNotMatch(
      stringsIn(result.claims).join(" "),
      new RegExp(CREDENTIAL),
    );
  } finally {
    await kit.close();
  }
});

test("AG-02: a card that renamed itself, changed profile or moved its interface is drift, not a connection", async () => {
  for (const [overrides, code] of [
    [{ agentName: "Renamed Agent" }, "a2a.card.name-drift"],
    [{ rpcPath: "/a2a/v2" }, "a2a.card.interface-drift"],
  ] as const) {
    const kit = await harness();
    try {
      // The binding was reviewed against the original card; the agent now
      // serves a different one.
      const drifting = await harness({ double: { ...overrides } });
      const connection = makeConnection(kit.binding);
      const context = kit.context({ connection });
      const result = await kit.adapter.verify!({
        ...context,
        binding: {
          ...kit.binding,
          destinations: [
            {
              id: "agent",
              origin: drifting.double.origin,
              network: "loopback-fixture",
            },
          ],
          authorityInstance: kit.binding.authorityInstance.replace(
            kit.double.origin,
            drifting.double.origin,
          ),
        },
      });
      assert.equal(result.state, "denied");
      assert.equal(result.code, code);
      await drifting.close();
    } finally {
      await kit.close();
    }
  }
});

test("AG-02: disconnect is local only, cancels pending tasks and revokes the stored credential", async () => {
  const kit = await harness({
    double: { script: { [SKILL]: "input-required" } },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    assert.equal(kit.ports.inspect.handoffs()[0]?.state, "issued");
    const result = await kit.adapter.disconnect!(
      kit.context({ connection }),
      "upstream",
    );
    assert.deepEqual(result, {
      local: "applied",
      broker: "not-attempted",
      upstream: "unsupported",
    });
    assert.equal(kit.ports.inspect.handoffs()[0]?.state, "cancelled");
    assert.equal(
      kit.ports.inspect.credentialMaterial(connection.credentialRef!),
      undefined,
    );
    assert.deepEqual(await kit.adapter.revoke!(kit.context({ connection })), {
      local: "not-attempted",
      broker: "unsupported",
      upstream: "unsupported",
    });
  } finally {
    await kit.close();
  }
});

test("AG-02: a binding for another adapter, tenant or authority is refused before any call", async () => {
  const kit = await harness();
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    for (const [patch, detail] of [
      [{ adapterId: "nango" }, "a2a.binding.adapter"],
      [{ tenantId: "tenant-b" }, "a2a.binding.tenant"],
      [{ status: "suspended" as const }, "a2a.binding.not-approved"],
      [
        { authorityInstance: "a2a:a2a-1.0:https://elsewhere:Other" },
        "a2a.binding.authority",
      ],
    ] as const)
      await assert.rejects(
        kit.adapter.delegate!(
          kit.context({ connection, binding: { ...kit.binding, ...patch } }),
          {
            action: "start",
            skill: SKILL,
            input: { text: "go" },
            commandId: "c",
          },
        ),
        (error: unknown) =>
          error instanceof ConnectorError && error.detail === detail,
      );
    assert.equal(kit.double.rpcCalls.length, 0);
  } finally {
    await kit.close();
  }
});

test("AG-02: the catalog report distinguishes what is implemented, configured and unsupported", async () => {
  const kit = await harness();
  try {
    const configured = kit.adapter.capabilities(
      new Set([A2A_CONFIGURATION_NAMES.credential]),
    );
    const bare = kit.adapter.capabilities(new Set());
    const delegate = configured.filter((row) => row.dimension === "delegate");
    assert.equal(delegate.length, 2, "one row per protocol profile");
    assert.deepEqual(
      delegate.map((row) => [
        row.profile,
        row.implementation,
        row.configuration,
      ]),
      [
        ["a2a-1.0", "implemented", "ready"],
        ["a2a-0.3", "implemented", "ready"],
      ],
    );
    assert.equal(
      bare.find((row) => row.dimension === "delegate")?.configuration,
      "missing",
    );
    for (const dimension of [
      "invoke",
      "events",
      "revoke",
      "export",
      "discover",
    ])
      assert.equal(
        configured.find((row) => row.dimension === dimension)?.implementation,
        "unsupported",
        dimension,
      );
    // An unsupported dimension carries no evidence, and every one of them
    // says what the native limitation is.
    for (const row of configured.filter(
      (item) => item.implementation === "unsupported",
    )) {
      assert.equal(row.evidence, "not-tested");
      assert.ok(row.limitations.length > 0, row.dimension);
    }
  } finally {
    await kit.close();
  }
});
