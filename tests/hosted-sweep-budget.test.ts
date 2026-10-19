import assert from "node:assert/strict";
import test from "node:test";
import { dispatchHostedTenants } from "../src/server/hosted/continuations.js";
import type { HostedRuntime } from "../src/server/hosted/runtime.js";

/*
 * The scheduled dispatcher's order and its budget. Every tenant's continuations
 * are dispatched before any tenant is swept, so a tenant with a lot to sweep
 * (or a custody service that answers slowly) delays housekeeping and never
 * another tenant's wake. The sweep gets a budget of its own, measured on a
 * monotonic clock; a tenant it does not reach is swept by the next call. What
 * the sweep did, and what it could not do, is in the report and in one log
 * line made of counts only.
 */

const SWEEP = { swept: 0, failed: 0 };

/** A runtime with nothing to dispatch, that says which tenant it was asked about. */
function runtimeWith(events: string[]) {
  return {
    store: {
      transaction: (work: (tx: unknown) => Promise<unknown>) =>
        work({
          list: async (tenant: string) => {
            events.push(`dispatch:${tenant}`);
            return [];
          },
        }),
      close: async () => {},
    },
  } as unknown as HostedRuntime;
}

const tenants = (...names: string[]) => ({ tenants: async () => names });

test("every tenant's continuations are dispatched before any tenant is swept", async () => {
  const events: string[] = [];
  await dispatchHostedTenants(
    runtimeWith(events),
    tenants("a", "b", "c"),
    async (tenant) => {
      events.push(`sweep:${tenant}`);
      return SWEEP;
    },
  );
  const firstSweep = events.findIndex((event) => event.startsWith("sweep:"));
  const lastDispatch = events.findLastIndex((event) =>
    event.startsWith("dispatch:"),
  );
  assert.ok(lastDispatch >= 0 && firstSweep > lastDispatch, events.join(" "));
  assert.deepEqual(
    events.filter((event) => event.startsWith("sweep:")),
    ["sweep:a", "sweep:b", "sweep:c"],
  );
});

test("a tenant the budget does not reach is not swept, and is reported", async () => {
  let clock = 1_000;
  const swept: string[] = [];
  const report = await dispatchHostedTenants(
    runtimeWith([]),
    tenants("a", "b", "c", "d"),
    async (tenant, stop) => {
      swept.push(tenant);
      assert.equal(stop(), false, "the budget is open while a tenant runs");
      clock += 6_000;
      return { swept: 1, failed: 0 };
    },
    { budgetMs: 10_000, monotonic: () => clock, log: () => {} },
  );
  // 6 s into the budget for the second, 12 s (spent) for the third.
  assert.deepEqual(swept, ["a", "b"]);
  assert.deepEqual(report, { swept: 2, failed: 0, incomplete: 2 });
});

test("the sweep is told when the budget is spent, and a sweep it cut short is reported", async () => {
  let clock = 0;
  const log: string[] = [];
  const report = await dispatchHostedTenants(
    runtimeWith([]),
    tenants("a", "b"),
    async (tenant, stop) => {
      assert.equal(stop(), false);
      clock += 11_000;
      assert.equal(stop(), true, "past the budget");
      return { swept: 1, failed: 0, stopped: true };
    },
    { budgetMs: 10_000, monotonic: () => clock, log: (line) => log.push(line) },
  );
  assert.deepEqual(report, { swept: 1, failed: 0, incomplete: 2 });
  assert.equal(log.length, 1, "one line says the sweep was cut short");
});

test("failures are counted into the report and logged as counts, and a clean run logs nothing", async () => {
  const log: string[] = [];
  const quiet = await dispatchHostedTenants(
    runtimeWith([]),
    tenants("a"),
    async () => ({ swept: 2, failed: 0 }),
    { log: (line) => log.push(line) },
  );
  assert.deepEqual(quiet, { swept: 2, failed: 0, incomplete: 0 });
  assert.equal(log.length, 0, "a clean run logs nothing");

  const report = await dispatchHostedTenants(
    runtimeWith([]),
    tenants("tenant-secret-name", "b"),
    async (tenant) =>
      tenant === "b" ? { swept: 1, failed: 0 } : { swept: 2, failed: 3 },
    { log: (line) => log.push(line) },
  );
  assert.deepEqual(report, { swept: 3, failed: 3, incomplete: 0 });
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0]!), {
    event: "custody-sweep",
    swept: 3,
    failed: 3,
    incomplete: 0,
    tenantsFailed: 0,
  });
  assert.ok(!log[0]!.includes("tenant-secret-name"), "no tenant name in it");
});

test("a tenant whose sweep throws is reported after the others had their turn, with the counts logged", async () => {
  const log: string[] = [];
  const swept: string[] = [];
  await assert.rejects(
    dispatchHostedTenants(
      runtimeWith([]),
      tenants("a", "b"),
      async (tenant) => {
        swept.push(tenant);
        if (tenant === "a") throw new Error("synthetic outage");
        return { swept: 1, failed: 0 };
      },
      { log: (line) => log.push(line) },
    ),
    /dispatch incomplete/,
  );
  assert.deepEqual(swept, ["a", "b"]);
  assert.deepEqual(JSON.parse(log[0]!), {
    event: "custody-sweep",
    swept: 1,
    failed: 0,
    incomplete: 0,
    tenantsFailed: 1,
  });
});
