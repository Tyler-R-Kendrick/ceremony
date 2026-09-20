import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  CeremonyDatabase,
  type ServerCeremonyEvent,
} from "../src/server/storage.js";

// `deliverEvents` reads each stored event back through `serverEventSchema`
// before handing it to the consumer. The schema is what carries the event's
// shape across that read: drop a field from it and the consumer is handed an
// event missing that field, silently, because zod strips what the schema does
// not name. This was only ever caught by a browser-outage chaos test that
// happened to assert the delivered event whole - a real gap, since that test
// launches a browser and has no business gating a core schema. This asserts
// the shape directly, so the schema cannot be hollowed out without a unit
// test failing here.
test("event delivery preserves the whole server event, every field", async (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const event: ServerCeremonyEvent = {
    eventId: randomUUID(),
    instanceId: "run-42",
    revision: 3,
    step: "complete",
    occurredAt: 1_710_000_000_000,
    status: "success",
    action: "authorize",
  };
  db.put(`event:${event.eventId}`, event);
  const delivered: ServerCeremonyEvent[] = [];
  const count = await db.deliverEvents(async (received) => {
    delivered.push(received);
  });
  assert.equal(count, 1);
  // Field by field, not a subset: an emptied schema would deliver `{}`.
  assert.deepEqual(delivered, [event]);
});

test("event delivery refuses a record that is not a server event", async (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  // A record under the event prefix whose shape the schema rejects: the read
  // must throw rather than deliver a malformed event as if it were valid.
  db.put(`event:${randomUUID()}`, { eventId: "not-a-uuid", step: 7 });
  await assert.rejects(
    db.deliverEvents(async () => {
      assert.fail("a malformed event must not be delivered");
    }),
  );
});
