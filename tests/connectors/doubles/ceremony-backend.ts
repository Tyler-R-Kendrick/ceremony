import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import {
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
} from "../../../src/server/persistence/index.js";
import { postgresFixture } from "../../fixtures/postgres.js";
import { memoryPorts } from "./ports.js";

/*
 * Where a provider harness keeps its state. "sqlite" is the encrypted SQLite
 * store every harness used until now; "postgres" is the same ports on the
 * embedded PostgreSQL; "memory" runs the connector ports on the in-memory
 * double, with an SQLite store beside it for the policy and the delegation
 * records, which are not connector ports. A race that a test holds open
 * should come out the same on all three.
 */

export type CeremonyBackend = "sqlite" | "memory" | "postgres";

export type ConnectorPorts = ReturnType<typeof createConnectorPorts>;

export async function ceremonyBackend(
  t: TestContext,
  options: {
    now: () => number;
    backend?: CeremonyBackend | undefined;
    expirySafetyMarginMs?: number | undefined;
  },
): Promise<{ store: AsyncCeremonyStore; ports: ConnectorPorts }> {
  const backend = options.backend ?? "sqlite";
  const keyring = { current: "test", keys: { test: randomBytes(32) } };
  let store: AsyncCeremonyStore;
  if (backend === "postgres") {
    const database = await postgresFixture();
    const postgres = new PostgresCeremonyStore(database.config, keyring);
    await postgres.migrate();
    t.after(async () => {
      await postgres.close();
      await database.close();
    });
    store = postgres;
  } else {
    const sqlite = new SQLiteCeremonyStore(":memory:", keyring);
    t.after(() => sqlite.close());
    store = sqlite;
  }
  const ports =
    backend === "memory"
      ? (memoryPorts({ now: options.now }) as unknown as ConnectorPorts)
      : createConnectorPorts(store, {
          now: options.now,
          ...(options.expirySafetyMarginMs === undefined
            ? {}
            : { expirySafetyMarginMs: options.expirySafetyMarginMs }),
        });
  return { store, ports };
}
