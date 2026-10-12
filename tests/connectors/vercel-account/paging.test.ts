import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { listTeams } from "../../../src/server/connectors/providers/vercel-account/client.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import type { PersonSeed } from "../doubles/vercel-account.js";
import {
  accountSetup,
  alice,
  connectAndApprove,
  connectAndChoose,
  START_TIME,
} from "./harness.js";

/*
 * A team listing is read a page at a time, up to a bound. What it returns is a
 * set, and a listing that was cut off is unknown rather than complete:
 * "nothing permitted", "exactly one" and "the team is gone" are claims about
 * the whole list, so none is made from a part of it.
 */

const DAY = 86_400_000;

const teamsOf = (count: number): PersonSeed["teams"] =>
  Array.from({ length: count }, (_, index) => ({
    id: `team_dummy_${index}`,
    slug: `team-${index}`,
    createdAt: START_TIME - (index + 1) * DAY,
  }));

test("a team listed on two pages is one team, and a listing that stops advancing is cut off", async (t) => {
  const { binding } = await accountSetup(t);
  let served = 0;
  const server = await startHttpFixture(() => ({
    status: 200,
    body: {
      teams: [{ id: "team_same", slug: "same" }],
      pagination: { next: 100 + served++ },
    },
  }));
  t.after(() => server.close());
  const ctx = {
    binding: runtimeBindingSchema.parse({
      ...binding,
      destinations: [
        { id: "api", origin: server.origin, network: "loopback-fixture" },
      ],
    }),
    signal: new AbortController().signal,
    environment: { fetch: globalThis.fetch },
  } as unknown as AdapterCallContext;
  const listing = await listTeams(ctx, "vca_dummy_bearer");
  assert.deepEqual(
    listing.teams.map((team) => team.id),
    ["team_same"],
  );
  assert.equal(listing.truncated, true);
  assert.equal(server.requests.length, 2, "it stopped once nothing was new");
});

test("nothing permitted among the teams that were read, with more unread, is not 'nothing permitted'", async (t) => {
  // Seven teams, one per page, five pages read; the binding permits only the seventh.
  const person = { ...alice, teams: teamsOf(7) };
  const setup = await accountSetup(t, {
    people: [person],
    teams: ["team_dummy_6"],
    double: { pageCap: 1 },
  });
  const { polled } = await connectAndApprove(setup);
  const view = polled as { lifecycle: string; lastOutcome?: string };
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(
    view.lastOutcome,
    "vercel-account.selection.listing-incomplete",
    "the answer says the listing was cut off, not that nothing is permitted",
  );
});

test("the one permitted team that was found is not bound while the listing was cut off", async (t) => {
  const person = { ...alice, teams: teamsOf(7) };
  const setup = await accountSetup(t, {
    people: [person],
    teams: ["team_dummy_0"],
    double: { pageCap: 1 },
  });
  const { polled } = await connectAndApprove(setup);
  assert.equal((polled as { lifecycle: string }).lifecycle, "human-required");
});

test("a listing read whole still binds the one permitted team without asking", async (t) => {
  const setup = await accountSetup(t, { teams: ["team_dummy_acme"] });
  const { polled } = await connectAndApprove(setup);
  assert.equal((polled as { lifecycle: string }).lifecycle, "active");
});

test("a team pushed beyond the pages that are read is not reported as left", async (t) => {
  const setup = await accountSetup(t, { double: { pageCap: 1 } });
  const { connectionRef } = await connectAndChoose(setup);
  // Five newer teams: the bound one is now past the fifth page.
  for (let index = 0; index < 5; index++)
    setup.fixture.addTeam(alice.id, {
      id: `team_dummy_new_${index}`,
      slug: `new-${index}`,
      createdAt: START_TIME + (index + 1) * DAY,
    });
  const view = (await setup.service.verify(setup.person, connectionRef)) as {
    lifecycle: string;
    lastOutcome?: string;
  };
  assert.equal(view.lifecycle, "indeterminate");
  assert.equal(view.lastOutcome, "vercel-account.team.not-listed");
  // And when the list is whole and the team is not in it, the team has been left.
  const whole = await accountSetup(t);
  const bound = await connectAndChoose(whole);
  whole.fixture.leaveTeam(alice.id, "team_dummy_acme");
  const left = (await whole.service.verify(
    whole.person,
    bound.connectionRef,
  )) as { lifecycle: string; lastOutcome?: string };
  assert.equal(left.lastOutcome, "vercel-account.team.left");
});
