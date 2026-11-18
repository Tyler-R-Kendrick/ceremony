export const title = "A lease on one key";

const holdsFence = (v, p) => v.fence[p].generation > 0;
const processes = (v) => Object.keys(v.pc);
// The process whose fence is the lease on the key right now.
const holder = (v) =>
  processes(v).find((p) => holdsFence(v, p) && v.fenceEpoch[p] === v.epoch);
// A process still holds a fence from an earlier lease.
const oldHolder = (v) =>
  processes(v).some((p) => holdsFence(v, p) && v.fenceEpoch[p] !== v.epoch);
const free = (v) => v.claim.generation === 0 || v.claim.worker === "cancelled";
const ranOut = (v) => !free(v) && v.claim.expires <= v.now;
const open = (v) => v.lock !== "-";
const inTransaction = (v) =>
  processes(v).filter((p) => v.pc[p] === "asserted").length;
const oldInTransaction = (v) =>
  processes(v).filter(
    (p) => v.pc[p] === "asserted" && v.fenceEpoch[p] !== v.epoch,
  ).length;

// A rule broke. Only a Broken*.cfg or Finding*.cfg run reaches these.
const broken = (v) =>
  v.staleFenceCommitted
    ? "An old fence committed"
    : v.liveLeaseTakenOver
      ? "A live lease was taken away"
      : v.expiredFencePassed
        ? "A fence was accepted after its lease ran out"
        : v.staleRevisionWrote
          ? "A write replaced a record its writer never read"
          : v.foreignLeaseExtended
            ? "A heartbeat extended another worker's lease"
            : v.expiredFenceReturned
              ? "A claim returned a fence whose time had run out"
              : v.oldFencePassedRestore
                ? "A fence from before the restore was accepted"
                : undefined;

const lease = (v) => {
  if (free(v)) return "Key free";
  if (!ranOut(v))
    return open(v) ? "Lease held, holder's transaction open" : "Lease held";
  if (open(v)) return "Lease ran out, holder's transaction still open";
  return holder(v)
    ? "Lease ran out, holder not told yet"
    : "Lease ran out, nobody holds the key";
};

// One state for every case in which a worker still holds the fence of an
// earlier lease. What the newer lease does meanwhile is not drawn.
export const state = (v) =>
  broken(v) ??
  (oldHolder(v) ? "Old holder still at work on its old fence" : lease(v));

export const group = (v) =>
  broken(v)
    ? "a rule broke"
    : oldHolder(v)
      ? "old holder at work"
      : free(v)
        ? "key free"
        : ranOut(v)
          ? "lease ran out"
          : "lease held";

export const colors = {
  "key free": "tan",
  "lease held": "teal",
  "lease ran out": "orange",
  "old holder at work": "purple",
  "a rule broke": "pink",
};

// What an old holder finds when its fence is refused.
const after = {
  "Key free": "key is free",
  "Lease held": "newer lease is held",
  "Lease ran out, holder not told yet":
    "newer lease ran out, its holder not told yet",
  "Lease ran out, nobody holds the key":
    "newer lease ran out, nobody holds the key",
};

export const step = (action, from, to) => {
  // Only a broken variant lets a worker commit on the fence of an earlier lease.
  const who =
    !from.staleFenceCommitted && to.staleFenceCommitted
      ? "an old holder"
      : "the holder";
  const changedHands = to.epoch > from.epoch;
  const wrote =
    to.nextWrite > from.nextWrite || to.rec.revision !== from.rec.revision;
  switch (action) {
    case "ClockTicks":
      return !ranOut(from) && ranOut(to)
        ? "the lease's time runs out"
        : "time passes";
    case "ReadRecord":
      return "a worker reads the record";
    case "ClaimReadsClock":
      return "a worker starts a claim";
    case "ClaimUpsert":
      if (!changedHands) return "a claim is refused, the lease is live";
      if (ranOut(to))
        return "a worker's slow claim lands after its time ran out";
      if (free(from)) return "a worker claims the key";
      return holder(from)
        ? "another worker takes the key over"
        : "a worker claims the key";
    case "AssertFence": {
      if (oldInTransaction(to) > oldInTransaction(from))
        return "an old holder's fence is accepted";
      if (inTransaction(to) > inTransaction(from))
        return "the holder's fence is accepted";
      if (holder(from) && !holder(to))
        return "the holder's fence is refused, its lease ran out";
      if (oldHolder(to)) return "an old holder's fence is refused";
      return `the old holder's fence is refused [${after[lease(to)]}]`;
    }
    case "HeartbeatExtends":
      if (
        processes(to).some(
          (p) => from.pc[p] === "asserted" && to.pc[p] === "idle",
        )
      )
        return "a heartbeat is refused, the lease is another's";
      return `${who}'s heartbeat commits`;
    case "FencedCommit":
      if (changedHands) return `${who} commits and releases the key`;
      return wrote
        ? `${who} commits a write`
        : "the holder's write is refused, the record changed";
    case "CancelKey":
      return "someone cancels the key";
    case "ProcessRestarts":
      return "a worker restarts";
    case "OtherWriterCreates":
      return "a writer with no lease creates the record";
    case "OtherWriterRewrites":
      return "a writer with no lease rewrites the record";
    case "OtherWriterDeletes":
      return "a writer with no lease deletes the record";
    case "TakeBackup":
      return "the store is backed up";
    case "RestoreBackup":
      return "the backup is restored into a fresh database";
    case "ClockBoundReached":
      return "the clock stops";
    default:
      return action;
  }
};
