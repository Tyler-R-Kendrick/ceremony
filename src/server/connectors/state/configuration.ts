import type { ActorContext } from "../../../core/operation-contracts.js";
import type { AsyncCeremonyEnvironment } from "../../async-environment.js";
import type { ConfigurationPort } from "../ports.js";
import { sha256Hex } from "./common.js";

/*
 * Configuration ports are bound to one actor and one set of names by the
 * command layer. Values never leave server code; `present` reports names
 * only; `revision` is part of the connection key and changes whenever the
 * underlying configuration record changes. The session variant is
 * deliberately conservative: any edit to the session environment moves the
 * revision, which can only over-invalidate, never under-invalidate.
 */

const configurationName = /^[A-Z][A-Z0-9_]{0,95}$/;

function checkNames(names: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const name of names)
    if (configurationName.test(name)) set.add(name);
  return set;
}

/** Per-session encrypted environment, read fresh on every call. */
export function createSessionConfigurationPort(input: {
  environment: AsyncCeremonyEnvironment;
  actor: ActorContext;
  names: readonly string[];
}): ConfigurationPort {
  const allowed = checkNames(input.names);
  const read = () => input.environment.read(input.actor);
  return {
    async read(name) {
      if (!allowed.has(name)) return undefined;
      const value = (await read()).values[name];
      return value === undefined || value === "" ? undefined : value;
    },
    async present(names) {
      const values = (await read()).values;
      return new Set(
        names.filter((name) => allowed.has(name) && Boolean(values[name])),
      );
    },
    async revision() {
      const record = await read();
      return sha256Hex("session", input.actor.sessionId, record.revision);
    },
  };
}

/**
 * Host-level configuration (process environment or an operator secret store).
 * The host supplies the revision — a deployment or secret-version identifier —
 * so no digest is ever derived from secret values.
 */
export function createHostConfigurationPort(input: {
  values: Readonly<Record<string, string | undefined>>;
  names: readonly string[];
  revision: string;
}): ConfigurationPort {
  const allowed = checkNames(input.names);
  if (
    typeof input.revision !== "string" ||
    !input.revision.length ||
    input.revision.length > 200
  )
    throw new Error("Host configuration revision is required");
  const revision = sha256Hex("host", input.revision);
  return {
    async read(name) {
      if (!allowed.has(name)) return undefined;
      const value = input.values[name];
      return value === undefined || value === "" ? undefined : value;
    },
    async present(names) {
      return new Set(
        names.filter((name) => allowed.has(name) && Boolean(input.values[name])),
      );
    },
    async revision() {
      return revision;
    },
  };
}
