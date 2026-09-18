import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accessCacheKey,
  evaluateAccess,
  readCloudSearchStyleAcl,
  retrievalDescriptorSchema,
  samePrincipal,
  type AccessDecision,
  type MembershipAnswer,
  type MembershipPort,
  type RetrievalAcl,
  type RetrievalDescriptor,
  type RetrievalPrincipal,
} from "../../../src/server/connectors/formats/retrieval/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";

/*
 * The conformance cases live in JSON beside this file, written from the
 * documented Cloud Search ACL model. The evaluator is exercised against them
 * rather than against expectations this test computed for itself.
 */

type AclCase = {
  id: string;
  description: string;
  documentId: string;
  indexedAt?: number;
  endUserResolution?: "host-authenticated-subject" | "identity-source-mapping" | "unresolved";
  ingestionPrincipal?: { identitySource: string; id: string };
  acl: {
    readers: RetrievalPrincipal[];
    deniedReaders: RetrievalPrincipal[];
    inheritFrom?: string;
    inheritanceType: RetrievalAcl["inheritanceType"];
  };
  principal: RetrievalPrincipal;
  membership: (MembershipAnswer & { complete: boolean }) | null;
  expect: { allowed: boolean; reason?: AccessDecision["reason"] };
};

type InheritanceCase = {
  id: string;
  description: string;
  chain: Array<{
    id: string;
    readers: RetrievalPrincipal[];
    deniedReaders: RetrievalPrincipal[];
    inheritFrom?: string;
    inheritanceType: RetrievalAcl["inheritanceType"];
  }>;
  principal: RetrievalPrincipal;
  membership: MembershipAnswer & { complete: boolean };
  expect: { allowed: boolean; reason?: AccessDecision["reason"] };
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/retrieval/acl-cases.json", import.meta.url),
    "utf8",
  ),
) as { now: number; cases: AclCase[]; inheritance: InheritanceCase[] };

const items = JSON.parse(
  readFileSync(
    new URL("../fixtures/retrieval/cloud-search-items.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const NOW = fixture.now;
const DAY = 24 * 3600_000;

function descriptorFor(input: {
  documentId: string;
  acl: AclCase["acl"];
  indexedAt?: number;
  endUserResolution?: AclCase["endUserResolution"];
  ingestionPrincipal?: { identitySource: string; id: string };
}): RetrievalDescriptor {
  return retrievalDescriptorSchema.parse({
    schemaVersion: 1,
    sourceDocumentId: input.documentId,
    source: {
      datasourceId: "wiki",
      system: "Internal wiki",
      ingestionPrincipal: {
        kind: "user",
        identitySource: input.ingestionPrincipal?.identitySource ?? "corp",
        id: input.ingestionPrincipal?.id ?? "svc-indexer",
      },
      itemType: "CONTENT_ITEM",
    },
    acl: {
      readers: input.acl.readers,
      deniedReaders: input.acl.deniedReaders,
      owners: [],
      ...(input.acl.inheritFrom ? { inheritFrom: input.acl.inheritFrom } : {}),
      inheritanceType: input.acl.inheritanceType,
    },
    membership: {
      identitySources: ["corp"],
      maxStalenessMs: DAY,
      externalIdentitiesMapped: true,
    },
    endUserBinding: {
      identitySource: "corp",
      resolution: input.endUserResolution ?? "host-authenticated-subject",
    },
    freshness: {
      indexedAt: input.indexedAt ?? NOW - 3600_000,
      sourceVersion: "v1",
      aclMaxAgeMs: 7 * DAY,
    },
    nativeExtensions: {},
  });
}

function portFor(
  membership: (MembershipAnswer & { complete: boolean }) | null,
  acls: Record<string, RetrievalAcl> = {},
): MembershipPort {
  return {
    async membershipOf() {
      return membership ?? undefined;
    },
    async aclOf(documentId) {
      return acls[documentId];
    },
  };
}

for (const item of fixture.cases) {
  test(`ACL case: ${item.id} — ${item.description}`, async () => {
    const descriptor = descriptorFor(item);
    const decision = await evaluateAccess(
      descriptor,
      item.principal,
      portFor(item.membership),
      { now: NOW },
    );
    assert.equal(
      decision.allowed,
      item.expect.allowed,
      `${item.id}: expected allowed=${item.expect.allowed}`,
    );
    if (item.expect.reason)
      assert.equal(decision.reason, item.expect.reason, `${item.id}: reason`);
    if (decision.allowed) assert.equal(decision.reason, "allowed");
  });
}

for (const item of fixture.inheritance) {
  test(`Inheritance case: ${item.id} — ${item.description}`, async () => {
    const [leaf, ...parents] = item.chain;
    const acls: Record<string, RetrievalAcl> = {};
    for (const level of item.chain)
      acls[level.id] = {
        readers: level.readers,
        deniedReaders: level.deniedReaders,
        owners: [],
        ...(level.inheritFrom ? { inheritFrom: level.inheritFrom } : {}),
        inheritanceType: level.inheritanceType,
      };
    void parents;
    const descriptor = descriptorFor({
      documentId: leaf!.id,
      acl: {
        readers: leaf!.readers,
        deniedReaders: leaf!.deniedReaders,
        ...(leaf!.inheritFrom ? { inheritFrom: leaf!.inheritFrom } : {}),
        inheritanceType: leaf!.inheritanceType,
      },
    });
    const decision = await evaluateAccess(
      descriptor,
      item.principal,
      portFor(item.membership, acls),
      { now: NOW },
    );
    assert.equal(decision.allowed, item.expect.allowed, item.id);
    if (item.expect.reason) assert.equal(decision.reason, item.expect.reason);
  });
}

test("AC-EXT-16: a group revocation after ingestion changes the answer with no reindex", async () => {
  const descriptor = descriptorFor({
    documentId: "doc-shared",
    acl: {
      readers: [{ kind: "group", identitySource: "corp", id: "g-engineering" }],
      deniedReaders: [],
      inheritanceType: "NOT_APPLICABLE",
    },
  });
  const principal: RetrievalPrincipal = {
    kind: "user",
    identitySource: "corp",
    id: "u-ada",
  };
  const before = await evaluateAccess(
    descriptor,
    principal,
    portFor({
      groups: [{ kind: "group", identitySource: "corp", id: "g-engineering" }],
      domains: [],
      resolvedAt: NOW - 1000,
      complete: true,
    }),
    { now: NOW },
  );
  assert.equal(before.allowed, true);

  // Same descriptor, same captured ACL, later membership: access is gone.
  const after = await evaluateAccess(
    descriptor,
    principal,
    portFor({
      groups: [],
      domains: [],
      resolvedAt: NOW - 500,
      complete: true,
    }),
    { now: NOW },
  );
  assert.equal(after.allowed, false);
  assert.equal(after.reason, "no-matching-reader");
  // The two decisions cannot share a cache entry.
  assert.notEqual(before.cacheKey, after.cacheKey);
});

test("AC-EXT-16: the ingestion service account never grants end-user visibility", async () => {
  const ingestion = { identitySource: "corp", id: "svc-indexer" };
  // Even a descriptor whose ACL would match the service account refuses it.
  const descriptor = descriptorFor({
    documentId: "doc-ingested",
    ingestionPrincipal: ingestion,
    acl: {
      readers: [{ kind: "domain", id: "acme.test" }],
      deniedReaders: [],
      inheritanceType: "NOT_APPLICABLE",
    },
  });
  const decision = await evaluateAccess(
    descriptor,
    { kind: "user", identitySource: "corp", id: "svc-indexer" },
    portFor({
      groups: [],
      domains: ["acme.test"],
      resolvedAt: NOW - 1000,
      complete: true,
    }),
    { now: NOW },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ingestion-principal");

  // And a descriptor that tried to list its own indexer as a reader is invalid.
  assert.throws(
    () =>
      retrievalDescriptorSchema.parse({
        schemaVersion: 1,
        sourceDocumentId: "doc-bad",
        source: {
          datasourceId: "wiki",
          system: "Internal wiki",
          ingestionPrincipal: {
            kind: "user",
            identitySource: "corp",
            id: "svc-indexer",
          },
          itemType: "CONTENT_ITEM",
        },
        acl: {
          readers: [{ kind: "user", identitySource: "corp", id: "svc-indexer" }],
          deniedReaders: [],
          owners: [],
          inheritanceType: "NOT_APPLICABLE",
        },
        membership: {
          identitySources: ["corp"],
          maxStalenessMs: DAY,
          externalIdentitiesMapped: true,
        },
        endUserBinding: {
          identitySource: "corp",
          resolution: "host-authenticated-subject",
        },
        freshness: { indexedAt: NOW, aclMaxAgeMs: DAY },
        nativeExtensions: {},
      }),
    "a descriptor cannot grant its own indexer end-user visibility",
  );
});

test("AC-EXT-16: a cache key binds a decision to one principal and one membership snapshot", async () => {
  const descriptor = descriptorFor({
    documentId: "doc-cache",
    acl: {
      readers: [{ kind: "group", identitySource: "corp", id: "g-engineering" }],
      deniedReaders: [],
      inheritanceType: "NOT_APPLICABLE",
    },
  });
  const ada: RetrievalPrincipal = { kind: "user", identitySource: "corp", id: "u-ada" };
  const grace: RetrievalPrincipal = { kind: "user", identitySource: "corp", id: "u-grace" };
  const membership = {
    groups: [{ kind: "group" as const, identitySource: "corp", id: "g-engineering" }],
    domains: [],
    resolvedAt: NOW - 1000,
    complete: true,
  };
  const forAda = await evaluateAccess(descriptor, ada, portFor(membership), {
    now: NOW,
  });
  const forGrace = await evaluateAccess(
    descriptor,
    grace,
    portFor({ groups: [], domains: [], resolvedAt: NOW - 1000, complete: true }),
    { now: NOW },
  );
  assert.equal(forAda.allowed, true);
  assert.equal(forGrace.allowed, false);
  // A cache keyed this way cannot serve one principal's answer to another,
  // even in the same tenant, document and moment.
  assert.notEqual(forAda.cacheKey, forGrace.cacheKey);
  assert.ok(forAda.cacheKey.includes("u-ada"));
  assert.ok(forGrace.cacheKey.includes("u-grace"));

  // Two identity sources with the same user id are different principals.
  assert.notEqual(
    accessCacheKey({
      descriptor,
      principal: ada,
      indexedAt: descriptor.freshness.indexedAt,
    }),
    accessCacheKey({
      descriptor,
      principal: { kind: "user", identitySource: "partner", id: "u-ada" },
      indexedAt: descriptor.freshness.indexedAt,
    }),
  );
  // A reindex with a new capture invalidates the key.
  assert.notEqual(
    accessCacheKey({ descriptor, principal: ada, indexedAt: 1 }),
    accessCacheKey({ descriptor, principal: ada, indexedAt: 2 }),
  );
  assert.ok(forAda.membershipResolvedAt === membership.resolvedAt);
});

test("a deleted document's ACL cannot be resolved, so inheritance from it denies", async () => {
  const descriptor = descriptorFor({
    documentId: "doc-orphan",
    acl: {
      readers: [{ kind: "user", identitySource: "corp", id: "u-ada" }],
      deniedReaders: [],
      inheritFrom: "folder-deleted",
      inheritanceType: "CHILD_OVERRIDE",
    },
  });
  const decision = await evaluateAccess(
    descriptor,
    { kind: "user", identitySource: "corp", id: "u-ada" },
    {
      async membershipOf() {
        return { groups: [], domains: [], resolvedAt: NOW - 1000, complete: true };
      },
      // No aclOf at all: a port that cannot resolve parents denies chains.
    },
    { now: NOW },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "inheritance-unresolved");
});

test("an inheritance chain deeper than the limit is unresolved, not truncated", async () => {
  const acls: Record<string, RetrievalAcl> = {};
  for (let index = 0; index < 40; index++)
    acls[`level-${index}`] = {
      readers: [],
      deniedReaders: [],
      owners: [],
      inheritFrom: `level-${index + 1}`,
      inheritanceType: "CHILD_OVERRIDE",
    };
  const descriptor = descriptorFor({
    documentId: "level-0",
    acl: {
      readers: [{ kind: "user", identitySource: "corp", id: "u-ada" }],
      deniedReaders: [],
      inheritFrom: "level-1",
      inheritanceType: "CHILD_OVERRIDE",
    },
  });
  const decision = await evaluateAccess(
    descriptor,
    { kind: "user", identitySource: "corp", id: "u-ada" },
    portFor(
      { groups: [], domains: [], resolvedAt: NOW - 1000, complete: true },
      acls,
    ),
    { now: NOW, maxDepth: 4 },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "inheritance-unresolved");
});

test("evaluation records the levels it consulted for audit", async () => {
  const descriptor = descriptorFor({
    documentId: "doc-child",
    acl: {
      readers: [{ kind: "user", identitySource: "corp", id: "u-ada" }],
      deniedReaders: [],
      inheritFrom: "folder-parent",
      inheritanceType: "CHILD_OVERRIDE",
    },
  });
  const decision = await evaluateAccess(
    descriptor,
    { kind: "user", identitySource: "corp", id: "u-ada" },
    portFor(
      { groups: [], domains: [], resolvedAt: NOW - 1000, complete: true },
      {
        "folder-parent": {
          readers: [],
          deniedReaders: [],
          owners: [],
          inheritanceType: "NOT_APPLICABLE",
        },
      },
    ),
    { now: NOW },
  );
  assert.deepEqual(decision.evaluated, ["doc-child", "folder-parent"]);
  assert.equal(decision.allowed, true);
});

test("principals compare exactly, with no case folding or suffix matching", () => {
  assert.equal(
    samePrincipal(
      { kind: "user", identitySource: "corp", id: "u-ada" },
      { kind: "user", identitySource: "corp", id: "u-ada" },
    ),
    true,
  );
  assert.equal(
    samePrincipal(
      { kind: "user", identitySource: "corp", id: "u-ada" },
      { kind: "user", identitySource: "corp", id: "U-ADA" },
    ),
    false,
  );
  assert.equal(
    samePrincipal(
      { kind: "user", identitySource: "corp", id: "u-ada" },
      { kind: "user", identitySource: "partner", id: "u-ada" },
    ),
    false,
  );
  assert.equal(
    samePrincipal(
      { kind: "user", identitySource: "corp", id: "u-ada" },
      { kind: "group", identitySource: "corp", id: "u-ada" },
    ),
    false,
  );
});

test("a descriptor that inherits without an inheritance type is invalid", () => {
  assert.throws(() =>
    retrievalDescriptorSchema.parse({
      schemaVersion: 1,
      sourceDocumentId: "doc",
      source: {
        datasourceId: "wiki",
        system: "wiki",
        ingestionPrincipal: { kind: "user", identitySource: "corp", id: "svc" },
        itemType: "CONTENT_ITEM",
      },
      acl: {
        readers: [],
        deniedReaders: [],
        owners: [],
        inheritFrom: "parent",
        inheritanceType: "NOT_APPLICABLE",
      },
      membership: {
        identitySources: ["corp"],
        maxStalenessMs: DAY,
        externalIdentitiesMapped: true,
      },
      endUserBinding: {
        identitySource: "corp",
        resolution: "host-authenticated-subject",
      },
      freshness: { indexedAt: NOW, aclMaxAgeMs: DAY },
      nativeExtensions: {},
    }),
  );
});

/* ---- Cloud Search-informed reader ---- */

const readerOptions = {
  datasourceId: "drive",
  system: "Google Drive",
  ingestionPrincipal: { identitySource: "", id: "indexer@project.iam.test" },
  endUserIdentitySource: "",
  membership: {
    identitySources: [""],
    maxStalenessMs: DAY,
    externalIdentitiesMapped: false,
  },
  freshness: { indexedAt: NOW - 3600_000, aclMaxAgeMs: 7 * DAY },
};

test("a Cloud Search item ACL normalizes into a descriptor with its principals intact", () => {
  const descriptor = readCloudSearchStyleAcl({
    ...readerOptions,
    item: items.gsuiteItem,
  });
  assert.equal(descriptor.sourceDocumentId, "datasources/drive/items/design-doc");
  assert.equal(descriptor.source.containerId, "datasources/drive/items/design-folder");
  assert.equal(descriptor.freshness.sourceVersion, "AQIDBAU=");
  assert.deepEqual(descriptor.acl.readers, [
    { kind: "user", identitySource: "", id: "ada@acme.test" },
    { kind: "group", identitySource: "", id: "engineering@acme.test" },
  ]);
  assert.deepEqual(descriptor.acl.deniedReaders, [
    { kind: "user", identitySource: "", id: "contractor@acme.test" },
  ]);
  assert.equal(descriptor.acl.inheritFrom, "datasources/drive/items/design-folder");
  assert.equal(descriptor.acl.inheritanceType, "PARENT_OVERRIDE");
  assert.equal(descriptor.nativeExtensions["cloud-search.itemType"], "CONTENT_ITEM");
});

test("external identity-source resource names keep their source and id", () => {
  const descriptor = readCloudSearchStyleAcl({
    ...readerOptions,
    endUserIdentitySource: "corp",
    membership: {
      identitySources: ["corp"],
      maxStalenessMs: DAY,
      externalIdentitiesMapped: true,
    },
    item: items.externalIdentityItem,
  });
  assert.deepEqual(descriptor.acl.readers, [
    { kind: "user", identitySource: "corp", id: "u-ada" },
    { kind: "group", identitySource: "corp", id: "g-engineering" },
  ]);
  assert.deepEqual(descriptor.acl.deniedReaders, [
    { kind: "group", identitySource: "corp", id: "g-contractors" },
  ]);
});

test("a whole-domain grant must name its domain", () => {
  assert.throws(
    () => readCloudSearchStyleAcl({ ...readerOptions, item: items.domainFlagItem }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "retrieval.principal.domain-unnamed",
  );
  const descriptor = readCloudSearchStyleAcl(
    { ...readerOptions, item: items.domainFlagItem },
    { defaultDomain: "acme.test" },
  );
  assert.deepEqual(descriptor.acl.readers, [
    { kind: "domain", id: "acme.test" },
  ]);
});

test("an ambiguous or unrecognized principal is rejected, never silently dropped", () => {
  assert.throws(
    () =>
      readCloudSearchStyleAcl({
        ...readerOptions,
        item: items.invalidPrincipalItem,
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "retrieval.acl.invalid",
  );
  assert.throws(
    () =>
      readCloudSearchStyleAcl({
        ...readerOptions,
        item: items.unrecognizedResourceItem,
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "retrieval.principal.unrecognized",
  );
});

test("an inheritance reference without a resolution rule is refused", () => {
  assert.throws(
    () =>
      readCloudSearchStyleAcl({
        ...readerOptions,
        item: items.inheritanceWithoutTypeItem,
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "retrieval.acl.inheritance-unspecified",
  );
});

test("a normalized Cloud Search descriptor evaluates end to end with its parent container", async () => {
  const descriptor = readCloudSearchStyleAcl({
    ...readerOptions,
    item: items.gsuiteItem,
  });
  const parent = readCloudSearchStyleAcl({
    ...readerOptions,
    item: items.containerItem,
  });
  const port = portFor(
    {
      groups: [
        { kind: "group", identitySource: "", id: "engineering@acme.test" },
      ],
      domains: ["acme.test"],
      resolvedAt: NOW - 1000,
      complete: true,
    },
    { "datasources/drive/items/design-folder": parent.acl },
  );
  const allowed = await evaluateAccess(
    descriptor,
    { kind: "user", identitySource: "", id: "ada@acme.test" },
    port,
    { now: NOW },
  );
  assert.equal(allowed.allowed, true);

  // The denied reader stays denied even though the parent container grants
  // the engineering group they belong to.
  const denied = await evaluateAccess(
    descriptor,
    { kind: "user", identitySource: "", id: "contractor@acme.test" },
    port,
    { now: NOW },
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "denied-reader");
});
