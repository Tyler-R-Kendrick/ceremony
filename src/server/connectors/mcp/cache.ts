import { createHash } from "node:crypto";
import { canonicalConnectorJson } from "../../../core/connectors/index.js";
import type { McpLimits } from "./profiles.js";

/*
 * Connection-scoped result cache. A server's `ttlMs`/`cacheScope` hints say
 * how long a list may be reused; they never say by whom. Every entry is keyed
 * by the principal (tenant, owner, connection, generation, profile and the
 * credential in use), so a personalized list that a server labelled
 * "public" still cannot be served to another principal. A generation change
 * or a different credential is a different key, which is the invalidation.
 */

export type CachePrincipal = {
  tenantId: string;
  ownerId: string;
  connectionRef: string;
  generation: number;
  profile: string;
  credentialRef?: string;
};

type Entry = {
  key: string;
  value: unknown;
  expiresAt: number;
  cacheScope: "public" | "private";
};

export function principalKey(principal: CachePrincipal): string {
  return createHash("sha256")
    .update(
      canonicalConnectorJson({
        tenantId: principal.tenantId,
        ownerId: principal.ownerId,
        connectionRef: principal.connectionRef,
        generation: principal.generation,
        profile: principal.profile,
        credentialRef: principal.credentialRef ?? "",
      }),
    )
    .digest("hex");
}

export function paramsDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(value ?? null))
    .digest("hex");
}

export class McpResultCache {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly now: () => number,
    private readonly limits: Pick<
      McpLimits,
      "cacheMaxTtlMs" | "cacheMaxEntries"
    >,
  ) {}

  private key(
    principal: CachePrincipal,
    method: string,
    params: unknown,
  ): string {
    return `${principalKey(principal)}|${method}|${paramsDigest(params)}`;
  }

  get<T>(
    principal: CachePrincipal,
    method: string,
    params: unknown,
  ): T | undefined {
    const key = this.key(principal, method, params);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency for the bounded eviction below.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value) as T;
  }

  set(
    principal: CachePrincipal,
    method: string,
    params: unknown,
    value: unknown,
    hint: {
      ttlMs: number | undefined;
      cacheScope: "public" | "private" | undefined;
    },
  ): void {
    // Absent or negative ttl is immediately stale (caching utility §ttl); a
    // ttl above the host bound is clamped to it.
    const ttl = Math.min(
      Math.max(0, Math.trunc(hint.ttlMs ?? 0)),
      this.limits.cacheMaxTtlMs,
    );
    if (ttl <= 0) return;
    const key = this.key(principal, method, params);
    this.entries.delete(key);
    this.entries.set(key, {
      key,
      value: structuredClone(value),
      expiresAt: this.now() + ttl,
      cacheScope: hint.cacheScope ?? "private",
    });
    while (this.entries.size > this.limits.cacheMaxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops every entry of one principal, or only one method's entries. */
  invalidate(principal: CachePrincipal, method?: string): number {
    const prefix = `${principalKey(principal)}|${method ? `${method}|` : ""}`;
    let count = 0;
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        count++;
      }
    return count;
  }

  get size(): number {
    return this.entries.size;
  }
}
