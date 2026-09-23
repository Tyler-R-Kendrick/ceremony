import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import type { RecordedCeremony } from "../src/core/recorded-ceremony.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import { AuthorizationError } from "../src/server/identity.js";
import {
  PersistenceConflict,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import { RecordedCeremonies } from "../src/server/recorded-ceremonies.js";

/**
 * Draft, review, publish — the recipe lifecycle, applied to recorded
 * ceremonies. What is worth testing is who can do what: an author (or the
 * author's agent) saves and edits its own drafts; only a person holding
 * `reviewer` approves a digest; only a person holding `publisher` turns an
 * approved digest into a version; and only that version, pinned by digest,
 * is ever handed to a replay.
 */

const who = (
  name: string,
  capabilities: ActorContext["capabilities"],
  options: { kind?: ActorContext["actorKind"]; tenant?: string } = {},
): ActorContext => ({
  tenantId: options.tenant ?? "tenant-a",
  subjectId: `subject-${name}`,
  sessionId: `session-${name}`,
  actorKind: options.kind ?? "human",
  capabilities,
});
const author = who("author", ["author", "executor"]);
const otherAuthor = who("other", ["author", "executor"]);
const reviewer = who("reviewer", ["reviewer"]);
const publisher = who("publisher", ["publisher"]);
const executor = who("executor", ["executor"]);
const agentReviewer = who("agent", ["reviewer", "publisher"], {
  kind: "agent",
});
const elsewhere = who("elsewhere", ["executor", "admin"], {
  tenant: "tenant-b",
});
const admin = who("admin", ["admin"]);

const recording = (): RecordedCeremony => ({
  schemaVersion: 1,
  id: "store-case",
  title: "Store case",
  goal: "sign-in",
  entry: { origin: "https://idp.example", path: "/signin" },
  origins: ["https://idp.example"],
  roles: ["password"],
  steps: [
    {
      id: "step-1",
      page: { origin: "https://idp.example", path: "/signin" },
      action: {
        kind: "fill",
        role: "password",
        target: {
          kind: "input",
          type: "password",
          label: "Password",
          ordinal: 0,
          of: 1,
        },
      },
      optional: false,
    },
  ],
  branches: [],
  success: [{ origin: "https://idp.example", path: "/" }],
  recordedWith: "host-model",
});

function harness() {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "k",
    keys: { k: randomBytes(32) },
  });
  return { store, recordings: new RecordedCeremonies(store) };
}

const denied = (error: unknown) =>
  error instanceof AuthorizationError && error.code === "denied";
const invalid = (error: unknown) =>
  error instanceof AuthorizationError && error.code === "invalid_request";

describe("RECORDED-STORE: draft, review, publish", () => {
  test("a draft is its author's; reviewers and publishers may read it; nobody else may", async () => {
    const { store, recordings } = harness();
    try {
      const draft = await recordings.saveDraft(author, recording(), {
        connectorId: "fixture",
        outcome: "verified",
      });
      assert.equal(
        (await recordings.readDraft(author, draft.draftId)).digest,
        draft.digest,
      );
      assert.equal(
        (await recordings.readDraft(reviewer, draft.draftId)).digest,
        draft.digest,
      );
      await assert.rejects(
        recordings.readDraft(otherAuthor, draft.draftId),
        denied,
      );
      await assert.rejects(
        recordings.readDraft(executor, draft.draftId),
        denied,
      );
      await assert.rejects(
        recordings.readDraft(elsewhere, draft.draftId),
        denied,
      );
      // Saving needs `author`; an executor alone cannot create one.
      await assert.rejects(
        recordings.saveDraft(executor, recording(), {
          connectorId: "fixture",
          outcome: "verified",
        }),
        denied,
      );
    } finally {
      await store.close();
    }
  });

  test("a recording with a value in it is not saved", async () => {
    const { store, recordings } = harness();
    try {
      const withValue = recording() as unknown as {
        steps: { action: Record<string, unknown> }[];
      };
      withValue.steps[0]!.action["value"] = "hunter2-canary";
      await assert.rejects(
        recordings.saveDraft(author, withValue as unknown as RecordedCeremony, {
          connectorId: "fixture",
          outcome: "verified",
        }),
      );
    } finally {
      await store.close();
    }
  });

  test("only a person reviews and publishes, and only the reviewed digest", async () => {
    const { store, recordings } = harness();
    try {
      const draft = await recordings.saveDraft(author, recording(), {
        connectorId: "fixture",
        outcome: "verified",
      });
      const approval = { revision: draft.revision, digest: draft.digest };
      await assert.rejects(
        recordings.review(author, draft.draftId, approval),
        denied,
      );
      await assert.rejects(
        recordings.review(agentReviewer, draft.draftId, approval),
        denied,
      );
      await assert.rejects(
        recordings.publish(agentReviewer, draft.draftId, approval),
        denied,
      );
      // Publishing needs a current review.
      await assert.rejects(
        recordings.publish(publisher, draft.draftId, approval),
        invalid,
      );
      await assert.rejects(
        recordings.review(reviewer, draft.draftId, {
          ...approval,
          digest: "A".repeat(43),
        }),
        invalid,
      );
      await recordings.review(reviewer, draft.draftId, approval);
      const first = await recordings.publish(
        publisher,
        draft.draftId,
        approval,
      );
      assert.deepEqual(first, {
        id: "store-case",
        version: "1.0.1",
        digest: draft.digest,
      });
      // A second publication of the same review is a new version, not an overwrite.
      const second = await recordings.publish(
        publisher,
        draft.draftId,
        approval,
      );
      assert.equal(second.version, "1.0.2");
      const replayable = await recordings.getPublished(executor, first);
      assert.deepEqual(replayable?.recording, recording());
      assert.equal(replayable?.connectorId, "fixture");
    } finally {
      await store.close();
    }
  });

  test("an edit is a new revision that no earlier review covers", async () => {
    const { store, recordings } = harness();
    try {
      const draft = await recordings.saveDraft(author, recording(), {
        connectorId: "fixture",
        outcome: "verified",
      });
      await recordings.review(reviewer, draft.draftId, {
        revision: draft.revision,
        digest: draft.digest,
      });
      // The author adds what one recording cannot see: an account chooser
      // that sometimes appears, where a person has to pick.
      const edited = await recordings.editDraft(author, draft.draftId, {
        revision: draft.revision,
        recording: {
          ...recording(),
          branches: [
            {
              id: "account-chooser",
              when: { origin: "https://idp.example", path: "/select-account" },
              then: { do: "stop", reason: "account-missing" },
            },
          ],
        },
      });
      assert.notEqual(edited.digest, draft.digest);
      assert.equal(edited.revision, draft.revision + 1);
      await assert.rejects(
        recordings.publish(publisher, draft.draftId, {
          revision: draft.revision,
          digest: draft.digest,
        }),
        (error: unknown) => error instanceof PersistenceConflict,
      );
      await assert.rejects(
        recordings.publish(publisher, draft.draftId, {
          revision: edited.revision,
          digest: edited.digest,
        }),
        invalid,
      );
      // An edit cannot rename the recording or rewrite how it came to be.
      for (const change of [
        { id: "renamed" },
        { recordedWith: "deterministic" },
      ])
        await assert.rejects(
          recordings.editDraft(author, draft.draftId, {
            revision: edited.revision,
            recording: { ...recording(), ...change },
          }),
          invalid,
        );
      // Nor can anyone but its author edit it.
      await assert.rejects(
        recordings.editDraft(otherAuthor, draft.draftId, {
          revision: edited.revision,
          recording: recording(),
        }),
        denied,
      );
    } finally {
      await store.close();
    }
  });

  test("a published version is pinned by digest, scoped to its tenant, and can be retired", async () => {
    const { store, recordings } = harness();
    try {
      const draft = await recordings.saveDraft(author, recording(), {
        connectorId: "fixture",
        outcome: "verified",
      });
      const approval = { revision: draft.revision, digest: draft.digest };
      await recordings.review(reviewer, draft.draftId, approval);
      const reference = await recordings.publish(
        publisher,
        draft.draftId,
        approval,
      );
      assert.equal(
        await recordings.getPublished(executor, {
          ...reference,
          digest: "B".repeat(43),
        }),
        undefined,
      );
      assert.equal(
        await recordings.getPublished(elsewhere, reference),
        undefined,
      );

      // Bytes changed underneath their digest are refused, not replayed.
      const key = {
        tenant: "tenant-a",
        kind: "artifact" as const,
        id: `recorded-ceremony:${reference.id}@${reference.version}`,
      };
      const stored = await store.transaction((tx) =>
        tx.get<Record<string, unknown>>(key),
      );
      await store.transaction((tx) =>
        tx.put(
          key,
          {
            ...stored!.value,
            recording: { ...recording(), title: "Tampered" },
          },
          stored!.revision,
        ),
      );
      assert.equal(
        await recordings.getPublished(executor, reference),
        undefined,
      );

      await store.transaction((tx) =>
        tx.put(key, stored!.value, stored!.revision + 1),
      );
      assert.ok(await recordings.getPublished(executor, reference));
      await assert.rejects(recordings.retire(publisher, reference), denied);
      await recordings.retire(admin, reference);
      assert.equal(
        await recordings.getPublished(executor, reference),
        undefined,
      );
    } finally {
      await store.close();
    }
  });
});
