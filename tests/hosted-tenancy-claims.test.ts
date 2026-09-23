import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError } from "../src/server/identity.js";
import {
  claimPath,
  HostedTenancy,
  hostedTenancy,
} from "../src/server/hosted/tenancy.js";

/*
 * Claim paths for hosted tenancy: a plain name is one top-level claim taken
 * whole (URL-shaped names included), a leading `/` is an RFC 6901 pointer into
 * nested claims. The hosted-platform suite covers the end-to-end sign-in over
 * PostgreSQL; this one pins the path grammar and how each value shape is read.
 */

const denied = (error: unknown) => error instanceof AuthorizationError;

test("a plain claim name is one top-level claim, dots and slashes included", () => {
  const tenancy = new HostedTenancy({
    claim: "https://example.invalid/claims.tenant",
  });
  assert.equal(
    tenancy.tenantFor({ "https://example.invalid/claims.tenant": "org-a" }),
    "org-a",
  );
  // A dot is never a separator: nothing here reads `claims` then `tenant`.
  assert.throws(
    () =>
      tenancy.tenantFor({
        "https://example.invalid/claims": { tenant: "org-a" },
      }),
    denied,
  );
  assert.deepEqual(claimPath("org"), ["org"]);
  assert.deepEqual(claimPath("realm_access.roles"), ["realm_access.roles"]);
});

test("a pointer reads nested claims, with ~1 and ~0 escapes", () => {
  assert.deepEqual(claimPath("/realm_access/roles"), ["realm_access", "roles"]);
  assert.deepEqual(claimPath("/https:~1~1example.invalid~1claims/org"), [
    "https://example.invalid/claims",
    "org",
  ]);
  assert.deepEqual(claimPath("/a~0b"), ["a~b"]);

  const tenancy = new HostedTenancy({
    claim: "/https:~1~1example.invalid~1claims/org",
    rolesClaim: "/realm_access/roles",
    rolesMap: { "ceremony-authors": ["author", "executor"] },
  });
  const claims = {
    "https://example.invalid/claims": { org: "org-b" },
    realm_access: { roles: ["ceremony-authors", "offline_access"] },
  };
  assert.equal(tenancy.tenantFor(claims), "org-b");
  assert.deepEqual(tenancy.capabilitiesFor(claims), ["author", "executor"]);
  // Space-separated roles still work at the end of a pointer.
  assert.deepEqual(
    tenancy.capabilitiesFor({ realm_access: { roles: "ceremony-authors" } }),
    ["author", "executor"],
  );
});

test("absent nested roles are the executor default; a missing nested tenant is refused", () => {
  const tenancy = new HostedTenancy({
    claim: "/org/id",
    rolesClaim: "/realm_access/roles",
  });
  assert.deepEqual(tenancy.capabilitiesFor({}), ["executor"]);
  assert.deepEqual(tenancy.capabilitiesFor({ realm_access: {} }), ["executor"]);
  assert.throws(() => tenancy.tenantFor({}), denied);
  assert.throws(() => tenancy.tenantFor({ org: {} }), denied);
});

test("arrays, numbers and other non-objects on the way, or at the end, are refused", () => {
  const tenancy = new HostedTenancy({
    claim: "/org/id",
    rolesClaim: "/realm_access/roles",
  });
  // A pointer walks objects only: an array is not indexed, a string not split.
  for (const org of [[{ id: "org-a" }], "org-a", 7, null, true])
    assert.throws(() => tenancy.tenantFor({ org }), denied);
  assert.throws(() => tenancy.tenantFor({ org: { id: 42 } }), denied);
  assert.throws(() => tenancy.tenantFor({ org: { id: ["org-a"] } }), denied);
  assert.throws(() => tenancy.tenantFor({ org: { id: { x: 1 } } }), denied);
  for (const realm_access of [["admin"], "admin", 3, null])
    assert.throws(() => tenancy.capabilitiesFor({ realm_access }), denied);
  assert.throws(
    () => tenancy.capabilitiesFor({ realm_access: { roles: [1, 2] } }),
    denied,
  );
  assert.throws(
    () => tenancy.capabilitiesFor({ realm_access: { roles: { admin: true } } }),
    denied,
  );
});

test("a pointer reads own properties only, never the prototype", () => {
  const tenancy = new HostedTenancy({
    claim: "/org/constructor",
    rolesClaim: "/__proto__/roles",
  });
  assert.throws(() => tenancy.tenantFor({ org: {} }), denied);
  assert.deepEqual(tenancy.capabilitiesFor({}), ["executor"]);
});

test("malformed paths are refused when tenancy is configured, never when a token arrives", () => {
  for (const bad of [
    "/",
    "//org",
    "/org/",
    "/org//id",
    "/org~2",
    "/org~",
    "/a/b/c/d/e/f/g/h/i",
    "org id",
    "",
  ]) {
    assert.throws(
      () => new HostedTenancy({ claim: bad }),
      Error,
      `tenant claim ${JSON.stringify(bad)}`,
    );
    assert.throws(
      () => new HostedTenancy({ home: "tenant", rolesClaim: bad }),
      Error,
      `roles claim ${JSON.stringify(bad)}`,
    );
    if (bad !== "")
      assert.throws(
        () =>
          hostedTenancy({
            CEREMONY_TENANT_CLAIM: bad,
          } as NodeJS.ProcessEnv),
        Error,
        `CEREMONY_TENANT_CLAIM=${JSON.stringify(bad)}`,
      );
  }
  const configured = hostedTenancy({
    CEREMONY_TENANT_CLAIM: "/org/id",
    CEREMONY_ROLES_CLAIM: "/realm_access/roles",
  } as NodeJS.ProcessEnv);
  assert.equal(configured.tenantFor({ org: { id: "org-c" } }), "org-c");
  assert.deepEqual(
    configured.capabilitiesFor({ realm_access: { roles: ["reviewer"] } }),
    ["reviewer"],
  );
  // Eight segments is the ceiling, not beyond it.
  assert.deepEqual(claimPath("/a/b/c/d/e/f/g/h").length, 8);
});
