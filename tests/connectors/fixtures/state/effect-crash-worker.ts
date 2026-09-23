import { PostgresCeremonyStore } from "../../../../src/server/persistence/index.js";
import { createConnectorPorts } from "../../../../src/server/connectors/state/index.js";
import { actorFor } from "./records.js";

/*
 * A separate operating-system process that shares one PostgreSQL database
 * with the test. It persists the intent of an external effect and then dies
 * in a chosen place, so the durability tests observe a real crash boundary
 * rather than a simulated one.
 */

const configuration = process.env.CEREMONY_CONNECTOR_STATE_WORKER;
if (configuration) {
  const config = JSON.parse(configuration);
  const store = new PostgresCeremonyStore(config.database, {
    current: "state",
    keys: { state: Buffer.from(config.key, "hex") },
  });
  const ports = createConnectorPorts(store, { worker: config.worker });
  const actor = actorFor(config.tenantId);
  const intent = {
    actor,
    operation: config.operation,
    digest: config.digest,
    commandId: config.commandId,
  };
  const begun = await ports.effects.begin(intent);
  if (config.mode === "die-after-begin") process.exit(81);
  await ports.effects.complete(begun.effectRef, {
    status: "applied",
    code: "provider.accepted",
    at: Date.now(),
  });
  if (config.mode === "die-after-complete") process.exit(82);
  await store.close();
}
