import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import type { LookupAddress } from "node:dns";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { SourceRecord } from "../../../src/core/connectors/index.js";
import {
  ConnectorError,
  explainConnectorError,
} from "../../../src/server/connectors/errors.js";
import type {
  DefinitionStorePort,
  SourceArtifactPort,
} from "../../../src/server/connectors/ports.js";
import {
  IMPORT_FIXTURE_ROOT,
  type NetworkPolicy,
} from "../../../src/server/connectors/import/index.js";

/*
 * Helpers shared by the import test files: memory doubles for the artifact
 * and source-record ports (kept as strict about tenancy and immutability as
 * the real state layer), fixture loading, the canary discipline and a few
 * policy builders. None of this is used by the product.
 */

export const CANARY = "CANARY_SECRET_9f3";

export const importActor: ActorContext = {
  tenantId: "tenant-import",
  subjectId: "author-1",
  sessionId: "session-1",
  actorKind: "human",
  capabilities: ["author"],
};

export const readOnlyActor: ActorContext = {
  ...importActor,
  subjectId: "viewer-1",
  capabilities: ["executor"],
};

export type MemoryArtifactPort = SourceArtifactPort & {
  entries(): Array<{
    ref: string;
    tenantId: string;
    bytes: Uint8Array;
    mediaType: string;
    digest: string;
    retainUntil?: number;
  }>;
};

export function memoryArtifactPort(): MemoryArtifactPort {
  const store = new Map<
    string,
    {
      tenantId: string;
      bytes: Uint8Array;
      mediaType: string;
      digest: string;
      retainUntil?: number;
    }
  >();
  return {
    async put(tenantId, bytes, meta) {
      const ref = `artifact:${randomUUID()}`;
      store.set(ref, {
        tenantId,
        bytes: new Uint8Array(bytes),
        mediaType: meta.mediaType,
        digest: meta.digest,
        ...(meta.retainUntil === undefined
          ? {}
          : { retainUntil: meta.retainUntil }),
      });
      return ref;
    },
    async get(tenantId, artifactRef) {
      const entry = store.get(artifactRef);
      if (!entry || entry.tenantId !== tenantId) return undefined;
      return {
        bytes: new Uint8Array(entry.bytes),
        mediaType: entry.mediaType,
        digest: entry.digest,
      };
    },
    async delete(tenantId, artifactRef) {
      const entry = store.get(artifactRef);
      if (entry && entry.tenantId === tenantId) store.delete(artifactRef);
    },
    entries() {
      return [...store.entries()].map(([ref, entry]) => ({ ref, ...entry }));
    },
  };
}

export type MemorySourceStore = Pick<
  DefinitionStorePort,
  "putSource" | "getSource"
> & {
  sources(): SourceRecord[];
};

/**
 * Records are stored by copy and are immutable. Writing the identical record
 * again is idempotent — the reference is content-addressed, so the same
 * capture yields the same record — but changing one in place fails the test.
 */
export function memorySourceStore(): MemorySourceStore {
  const records = new Map<string, SourceRecord>();
  return {
    async putSource(tenantId, source) {
      const key = `${tenantId}\u0000${source.sourceRef}`;
      const existing = records.get(key);
      if (existing) {
        assert.deepEqual(
          existing,
          source,
          `source record overwritten: ${source.sourceRef}`,
        );
        return;
      }
      records.set(key, structuredClone(source));
    },
    async getSource(tenantId, sourceRef) {
      const record = records.get(`${tenantId}\u0000${sourceRef}`);
      return record ? structuredClone(record) : undefined;
    },
    sources() {
      return [...records.values()].map((record) => structuredClone(record));
    },
  };
}

export function importPorts() {
  const artifacts = memoryArtifactPort();
  const definitions = memorySourceStore();
  return { artifacts, definitions, now: () => Date.UTC(2026, 8, 18, 12) };
}

export async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, `file://${IMPORT_FIXTURE_ROOT}`)));
}

export const encode = (text: string) => new TextEncoder().encode(text);

/** A small gzip member that inflates to `size` bytes of a valid JSON document. */
export function gzipBomb(size: number): Uint8Array {
  const filler = " ".repeat(Math.max(0, size - 2));
  return new Uint8Array(gzipSync(Buffer.from(`{${filler}}`)));
}

/** Fails if the canary appears anywhere in the rendered form of any value. */
export function assertNoCanary(...values: unknown[]): void {
  for (const value of values) {
    const rendered = [
      inspect(value, { depth: 20, showHidden: true, breakLength: Infinity }),
      (() => {
        try {
          return JSON.stringify(value) ?? "";
        } catch {
          return "";
        }
      })(),
      value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : "",
      value instanceof Error ? inspect(value.cause, { depth: 20 }) : "",
    ].join("\n");
    assert.equal(
      rendered.includes(CANARY),
      false,
      `canary leaked: ${rendered.slice(0, 200)}`,
    );
  }
}

/** Asserts a ConnectorError with the expected code (and detail), returning it for further checks. */
export async function expectConnectorError(
  work: Promise<unknown> | (() => unknown),
  code: ConnectorError["code"],
  detail?: string,
): Promise<ConnectorError> {
  let caught: unknown;
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ConnectorError,
    `expected ConnectorError(${code}), got ${inspect(caught)}`,
  );
  assert.equal(caught.code, code, `detail was ${caught.detail}`);
  if (detail !== undefined) assert.equal(caught.detail, detail);
  assert.equal(explainConnectorError(caught).code, code);
  return caught;
}

export function loopbackPolicy(
  overrides: Partial<NetworkPolicy> = {},
): NetworkPolicy {
  return {
    mode: "loopback-fixture",
    maxRedirects: 3,
    maxResponseBytes: 1024 * 1024,
    timeoutMs: 3_000,
    ...overrides,
  };
}

export function publicPolicy(
  overrides: Partial<NetworkPolicy> = {},
): NetworkPolicy {
  return {
    mode: "public",
    maxRedirects: 3,
    maxResponseBytes: 1024 * 1024,
    timeoutMs: 3_000,
    ...overrides,
  };
}

/** A resolver whose answers are consumed in order; the last answer repeats. */
export function answerQueue(...answers: LookupAddress[][]) {
  const calls: string[] = [];
  const resolve = async (hostname: string): Promise<LookupAddress[]> => {
    calls.push(hostname);
    const index = Math.min(calls.length - 1, answers.length - 1);
    return [...(answers[index] ?? [])];
  };
  return { resolve, calls };
}
