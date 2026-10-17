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

/** What a disconnect and an administrator's revoke write when they fence: who fenced, for a reader that finds a newer generation. */
export const CLOSING_OUTCOMES = [
  "disconnect.closing",
  "revoke.closing",
] as const;

/** Fenced by a disconnect or a revoke that has not written its closing lifecycle yet. */
export const closing = (record: ConnectionRecord) =>
  (CLOSING_OUTCOMES as readonly string[]).includes(record.lastOutcome ?? "");

/**
 * What a disconnect did to the record, from where it started to where closing
 * left it: it closed it (`applied`), or the record had already moved to
 * another generation, fenced by another disconnect or revoke that has closed
 * it (`already-closed`) or is still closing it (`already-closing`), or by a
 * reconnect (`superseded`), the only other command that fences. Either way
 * what this disconnect held was released; only the record was not its to
 * write.
 */
export function localOutcome(
  fenced: ClosingConnection,
  after: ClosingConnection,
  isClosed: (record: ConnectionRecord) => boolean,
): "applied" | "superseded" | "already-closed" | "already-closing" {
  if (after.record.generation === fenced.record.generation) return "applied";
  if (isClosed(after.record)) return "already-closed";
  return closing(after.record) ? "already-closing" : "superseded";
}
