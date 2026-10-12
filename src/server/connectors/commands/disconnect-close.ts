import type { ActorContext } from "../../../core/operation-contracts.js";
import { ConnectorError } from "../errors.js";
import type { ConnectionRecord, ConnectionStorePort } from "../ports.js";

/*
 * Closing a connection at the end of a disconnect. The disconnect fences the
 * connection (advances its generation), may talk to the provider for seconds,
 * and only then writes the closing lifecycle against the revision it held when
 * it fenced. Anything that wrote the connection in between (a verify, a poll,
 * a completion that was already running) has moved the revision, and a closing
 * write that simply failed would leave the tokens dropped and the provider told
 * while the record still said `active` with a credential that is gone.
 *
 * So the closing write is retried from a fresh read, a bounded number of times,
 * and what changed meanwhile is accounted for: a connection that is no longer
 * the generation this disconnect fenced (reconnected, disconnected again) is
 * someone else's now and is returned as it is; a credential a concurrent write
 * put on the record is revoked too, because it must not outlive the disconnect.
 */

/** Closing retries: each follows a write by someone else, which has to happen again to defeat it. */
export const CLOSE_ATTEMPTS = 6;

export type ClosingConnection = {
  record: ConnectionRecord;
  revision: number;
};

const isRevisionConflict = (error: unknown) =>
  (error instanceof ConnectorError && error.code === "conflict") ||
  (error instanceof Error && error.message === "conflict");

export async function closeDisconnected(
  connections: ConnectionStorePort,
  revokeCredential: (credentialRef: string) => Promise<void>,
  actor: ActorContext,
  fenced: ClosingConnection,
  patch: Partial<ConnectionRecord>,
): Promise<ClosingConnection> {
  const connectionRef = fenced.record.connectionRef;
  const revoked = new Set<string>(
    fenced.record.credentialRef ? [fenced.record.credentialRef] : [],
  );
  let current = fenced;
  for (let attempt = 1; ; attempt++) {
    try {
      const updated = await connections.update(
        actor,
        connectionRef,
        current.revision,
        patch,
      );
      return {
        record: { ...current.record, ...patch } as ConnectionRecord,
        revision: updated.revision,
      };
    } catch (error) {
      if (!isRevisionConflict(error) || attempt >= CLOSE_ATTEMPTS) throw error;
    }
    const fresh = await connections.get(actor, connectionRef);
    if (!fresh)
      throw new ConnectorError("not-found", { detail: "connection.unknown" });
    if (fresh.record.generation !== fenced.record.generation) return fresh;
    const added = fresh.record.credentialRef;
    if (added && !revoked.has(added)) {
      revoked.add(added);
      await revokeCredential(added);
    }
    current = fresh;
  }
}
