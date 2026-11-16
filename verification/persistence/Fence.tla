------------------------------- MODULE Fence -------------------------------
(***************************************************************************)
(* The lease ("claim") and the revision-checked write on ONE RecordKey of  *)
(* the persistence store, src/server/persistence/index.ts.                 *)
(*                                                                         *)
(* One step of this model is one SQL statement, or a run of statements     *)
(* that no other transaction can come between.  The PostgreSQL backend     *)
(* runs at READ COMMITTED, so two transactions do interleave there; what   *)
(* keeps a fenced transaction whole is the row lock that assertFence       *)
(* takes with SELECT ... FOR UPDATE (index.ts:166, :180).  The SQLite      *)
(* backend runs each transaction under BEGIN IMMEDIATE (index.ts:327), so  *)
(* its runs are the runs of this model in which a transaction's steps      *)
(* come one right after the other.                                         *)
(*                                                                         *)
(* README.md in this folder maps every action and variable to file:line.   *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
    Processes,       \* worker processes that call the store
    SharedIdentity,  \* TRUE: every process passes the same `worker` string to
                     \* claim(), as src/server/hosted/a2h.ts:39 does ("a2h")
    Duration,        \* durationMs of claim() and heartbeat(), in clock ticks
    MaxNow,          \* bound: the database clock runs from 0 to MaxNow
    MaxEpoch,        \* bound: successful claim() and cancel() calls together
    MaxWrites,       \* bound: record versions ever written
    Deletes,         \* scope: TRUE lets a record be deleted (tx.delete)
    WithEnvironment, \* scope: TRUE adds process restarts and writers that
                     \* hold no lease; FALSE only for the small chart model

    \* Each switch below is TRUE in the code as written.  FALSE removes one
    \* check, to show that a rule can fail (the Broken*.cfg files).
    CheckGeneration,      \* index.ts:188  Number(row.generation) !== fence.generation
    CheckExpiry,          \* index.ts:190  Number(row.expires) <= (await now())
    LockFenceRow,         \* index.ts:166  " FOR UPDATE" on the claim row read
    ClaimOnlyExpired,     \* index.ts:282  WHERE ceremony_claims.expires<=$6
    ClaimBumpsGeneration, \* index.ts:282  generation=ceremony_claims.generation+1
    CheckRevision         \* index.ts:238  AND revision=$6   (and :248 for delete)

VARIABLES
    \* ---- the database ----
    now,      \* the database clock, read by now() (index.ts:167-176)
    claim,    \* the ceremony_claims row of the key (index.ts:142-145)
    lock,     \* which process's open transaction holds the row lock on `claim`
    rec,      \* the ceremony_records row of the key (index.ts:139-141)
    \* ---- each worker process ----
    pc,        \* where the process is (see PcValues)
    fence,     \* the Fence that claim() returned to it (index.ts:67, :286)
    clockRead, \* `time` in claim(): the clock value it read (index.ts:280)
    seen,      \* the StoredRecord it last read; its expectedRevision
    \* ---- ghosts: history the rules are stated on; no code stores these ----
    epoch,      \* how many times the lease changed hands (claim or cancel)
    fenceEpoch, \* the value of `epoch` when the process got its fence
    nextWrite,  \* how many record versions were written so far
    staleFenceCommitted, \* latches TRUE when rule 1 breaks
    liveLeaseTakenOver,  \* latches TRUE when rule 2 breaks
    expiredFencePassed,  \* latches TRUE when rule 3 breaks
    staleRevisionWrote   \* latches TRUE when rule 4 breaks

db     == <<now, claim, lock, rec>>
local  == <<pc, fence, clockRead, seen>>
flags  == <<staleFenceCommitted, liveLeaseTakenOver, expiredFencePassed,
            staleRevisionWrote>>
ghosts == <<epoch, fenceEpoch, nextWrite, flags>>
vars   == <<db, local, ghosts>>

----------------------------------------------------------------------------
\* Rows.  Real generations and revisions start at 1, so 0 stands for
\* "no row" (and, for `seen`, for expectedRevision = null).
NoClaim  == [generation |-> 0, worker |-> "-", expires |-> 0]
NoRecord == [revision |-> 0, write |-> 0]
NoFence  == [generation |-> 0, worker |-> "-"]
NoLock   == "-"

PcValues == {
    "idle",      \* holds no fence, is in no transaction
    "claiming",  \* inside claim(): read the clock, has not run the upsert
    "working",   \* holds a fence, between transactions (the provider call)
    "asserted"   \* inside a fenced transaction: assertFence() returned
}

\* The `worker` argument of claim().
WorkerOf(p) == IF SharedIdentity THEN "same-workload" ELSE p

\* The row that cancel() leaves (index.ts:297-302).
Cancelled == [generation |-> claim.generation + 1,
              worker     |-> "cancelled",
              expires    |-> 0]

Unlock(p) == IF lock = p THEN NoLock ELSE lock

TypeOK ==
    /\ now \in 0..MaxNow
    /\ claim.generation \in 0..MaxEpoch
    /\ claim.expires \in 0..(MaxNow + Duration)
    /\ lock \in Processes \cup {NoLock}
    /\ rec.revision \in 0..MaxWrites
    /\ rec.write \in 0..MaxWrites
    /\ pc \in [Processes -> PcValues]
    /\ \A p \in Processes :
          /\ fence[p].generation \in 0..MaxEpoch
          /\ clockRead[p] \in 0..MaxNow
          /\ seen[p].revision \in 0..MaxWrites
          /\ fenceEpoch[p] \in 0..MaxEpoch
    /\ epoch \in 0..MaxEpoch
    /\ nextWrite \in 0..MaxWrites
    /\ staleFenceCommitted \in BOOLEAN
    /\ liveLeaseTakenOver \in BOOLEAN
    /\ expiredFencePassed \in BOOLEAN
    /\ staleRevisionWrote \in BOOLEAN

Init ==
    /\ now = 0
    /\ claim = NoClaim
    /\ lock = NoLock
    /\ rec = NoRecord
    /\ pc = [p \in Processes |-> "idle"]
    /\ fence = [p \in Processes |-> NoFence]
    /\ clockRead = [p \in Processes |-> 0]
    /\ seen = [p \in Processes |-> NoRecord]
    /\ epoch = 0
    /\ fenceEpoch = [p \in Processes |-> 0]
    /\ nextWrite = 0
    /\ staleFenceCommitted = FALSE
    /\ liveLeaseTakenOver = FALSE
    /\ expiredFencePassed = FALSE
    /\ staleRevisionWrote = FALSE

----------------------------------------------------------------------------
\* The database clock moves on.
ClockTicks ==
    /\ now < MaxNow
    /\ now' = now + 1
    /\ UNCHANGED <<claim, lock, rec, local, ghosts>>

\* tx.get / tx.list in a transaction of their own, or early in a longer one
\* (index.ts:204-222, :255-275).  The process keeps the revision it read and
\* passes it to a later put/delete, as src/server/agent/workflow-api.ts does
\* with row.revision (:31-39 read, :71 write).
ReadRecord(p) ==
    /\ pc[p] \in {"idle", "working", "asserted"}
    /\ seen[p] # rec
    /\ seen' = [seen EXCEPT ![p] = rec]
    /\ UNCHANGED <<db, pc, fence, clockRead, ghosts>>

\* claim(), first statement: `const time = await now()` (index.ts:280).
ClaimReadsClock(p) ==
    /\ pc[p] = "idle"
    /\ epoch < MaxEpoch
    /\ pc' = [pc EXCEPT ![p] = "claiming"]
    /\ clockRead' = [clockRead EXCEPT ![p] = now]
    /\ UNCHANGED <<db, fence, seen, ghosts>>

\* claim(), second statement, and the COMMIT of its transaction: the upsert
\* INSERT ... ON CONFLICT DO UPDATE ... WHERE expires<=$6 RETURNING generation
\* (index.ts:281-286).  The upsert waits while another transaction holds the
\* row, then decides on the row as committed.  An uncommitted upsert is not
\* visible to anyone, so upsert and COMMIT are one step here.
ClaimUpsert(p) ==
    /\ pc[p] = "claiming"
    /\ lock = NoLock
    /\ epoch < MaxEpoch
    /\ LET time    == clockRead[p]
           free    == claim = NoClaim
           lapsed  == claim.expires <= time
           newGeneration ==
               IF free THEN 1
               ELSE IF ClaimBumpsGeneration THEN claim.generation + 1
               ELSE claim.generation
       IN IF free \/ lapsed \/ ~ClaimOnlyExpired
          THEN /\ claim' = [generation |-> newGeneration,
                            worker     |-> WorkerOf(p),
                            expires    |-> time + Duration]
               /\ fence' = [fence EXCEPT ![p] =
                               [generation |-> newGeneration,
                                worker     |-> WorkerOf(p)]]
               /\ pc' = [pc EXCEPT ![p] = "working"]
               /\ epoch' = epoch + 1
               /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = epoch + 1]
               \* Rule 2 looks at the clock as it is now, not at `time`.
               /\ liveLeaseTakenOver' =
                      (liveLeaseTakenOver \/ (~free /\ claim.expires > now))
               /\ clockRead' = [clockRead EXCEPT ![p] = 0]
               /\ UNCHANGED <<now, lock, rec, seen, nextWrite,
                              staleFenceCommitted, expiredFencePassed,
                              staleRevisionWrote>>
          ELSE \* no row returned: PersistenceConflict (index.ts:285)
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ clockRead' = [clockRead EXCEPT ![p] = 0]
               /\ UNCHANGED <<db, fence, seen, ghosts>>

\* assertFence(): read the claim row and take its row lock, then compare it
\* with the fence and the clock (index.ts:184-193).  It opens the fenced
\* transaction of heartbeat() (index.ts:290) and of every fenced commit
\* (workflow-api.ts:69, connectors/state/effects.ts:252, hosted/a2h.ts:66, :81).
\* The lock stays until that transaction ends.
AssertFence(p) ==
    /\ pc[p] = "working"
    /\ lock = NoLock
    /\ LET live == claim # NoClaim /\ claim.expires > now
           ok   == /\ claim # NoClaim
                   /\ CheckGeneration => claim.generation = fence[p].generation
                   /\ claim.worker = fence[p].worker
                   /\ CheckExpiry => claim.expires > now
       IN IF ok
          THEN /\ pc' = [pc EXCEPT ![p] = "asserted"]
               /\ lock' = IF LockFenceRow THEN p ELSE lock
               /\ expiredFencePassed' = (expiredFencePassed \/ ~live)
               /\ UNCHANGED <<now, claim, rec, fence, clockRead, seen, epoch,
                              fenceEpoch, nextWrite, staleFenceCommitted,
                              liveLeaseTakenOver, staleRevisionWrote>>
          ELSE \* PersistenceConflict (index.ts:192): the lease is lost, the
               \* transaction rolls back, the process stops using the fence
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ fence' = [fence EXCEPT ![p] = NoFence]
               /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = 0]
               /\ UNCHANGED <<db, clockRead, seen, epoch, nextWrite, flags>>

\* heartbeat(), after its assertFence: UPDATE ceremony_claims SET expires
\* (index.ts:291-294), then COMMIT.  The UPDATE names the key only, not the
\* generation, so it extends whichever row is there.
HeartbeatExtends(p) ==
    /\ pc[p] = "asserted"
    /\ claim' = [claim EXCEPT !.expires = now + Duration]
    /\ staleFenceCommitted' = (staleFenceCommitted \/ fenceEpoch[p] # epoch)
    /\ lock' = Unlock(p)
    /\ pc' = [pc EXCEPT ![p] = "working"]
    /\ UNCHANGED <<now, rec, fence, clockRead, seen, epoch, fenceEpoch,
                   nextWrite, liveLeaseTakenOver, expiredFencePassed,
                   staleRevisionWrote>>

\* The rest of a fenced commit, after its assertFence, up to COMMIT:
\*   write   - tx.put (index.ts:223-243) or tx.delete (index.ts:244-254) with
\*             the revision the process read, or nothing;
\*   release - tx.cancel on the same key (index.ts:297-302), or not.
\* workflow-api.ts:68-73 is put-or-nothing with release; a2h.ts:81-84 is put
\* without release; a2h.ts:65-68 is release alone.  An uncommitted write is
\* not visible to anyone and holds its row, so the statements and the COMMIT
\* are one step here.
FencedCommit(p, write, release) ==
    /\ pc[p] = "asserted"
    /\ write \in {"put", "delete", "nothing"}
    /\ write = "nothing" => release
    /\ write = "delete" => Deletes /\ seen[p] # NoRecord
    /\ write = "put" => nextWrite < MaxWrites
    /\ release => epoch < MaxEpoch
    /\ LET expected == seen[p].revision     \* 0 is expectedRevision = null
           \* INSERT ... ON CONFLICT DO NOTHING (index.ts:234) when null,
           \* UPDATE/DELETE ... AND revision=$n (index.ts:238, :248) otherwise
           rowMatches ==
               IF expected = 0 THEN rec = NoRecord
               ELSE /\ rec # NoRecord
                    /\ CheckRevision => rec.revision = expected
           written == IF write = "put"
                      THEN [revision |-> expected + 1, write |-> nextWrite + 1]
                      ELSE NoRecord
       IN IF write = "nothing" \/ rowMatches
          THEN /\ rec' = IF write = "nothing" THEN rec ELSE written
               /\ seen' = IF write = "nothing" THEN seen
                          ELSE [seen EXCEPT ![p] = written]
               /\ nextWrite' = IF write = "put" THEN nextWrite + 1 ELSE nextWrite
               /\ claim' = IF release THEN Cancelled ELSE claim
               /\ epoch' = IF release THEN epoch + 1 ELSE epoch
               /\ fence' = IF release THEN [fence EXCEPT ![p] = NoFence] ELSE fence
               /\ fenceEpoch' = IF release THEN [fenceEpoch EXCEPT ![p] = 0]
                                ELSE fenceEpoch
               /\ pc' = [pc EXCEPT ![p] = IF release THEN "idle" ELSE "working"]
               /\ lock' = Unlock(p)
               /\ staleFenceCommitted' =
                      (staleFenceCommitted \/ fenceEpoch[p] # epoch)
               /\ staleRevisionWrote' =
                      (staleRevisionWrote \/ (write # "nothing" /\ seen[p] # rec))
               /\ UNCHANGED <<now, clockRead, liveLeaseTakenOver,
                              expiredFencePassed>>
          ELSE \* PersistenceConflict (index.ts:241, :253), then ROLLBACK
               \* (index.ts:358, :523): nothing is written, the lease stays
               /\ pc' = [pc EXCEPT ![p] = "working"]
               /\ lock' = Unlock(p)
               /\ UNCHANGED <<now, claim, rec, fence, clockRead, seen, ghosts>>

\* tx.cancel(key) by a caller that holds no fence, such as a person
\* cancelling the run (src/server/commands.ts:436).  One upsert (index.ts:299).
CancelKey ==
    /\ lock = NoLock
    /\ epoch < MaxEpoch
    /\ claim' = Cancelled
    /\ epoch' = epoch + 1
    /\ UNCHANGED <<now, lock, rec, local, fenceEpoch, nextWrite,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote>>

\* The process stops or restarts: its open transaction rolls back
\* (index.ts:358, :523) and what it held in memory is gone.  The claim row
\* stays as it is until it expires.
ProcessRestarts(p) ==
    /\ WithEnvironment
    /\ pc[p] # "idle"
    /\ pc' = [pc EXCEPT ![p] = "idle"]
    /\ fence' = [fence EXCEPT ![p] = NoFence]
    /\ seen' = [seen EXCEPT ![p] = NoRecord]
    /\ clockRead' = [clockRead EXCEPT ![p] = 0]
    /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = 0]
    /\ lock' = Unlock(p)
    /\ UNCHANGED <<now, claim, rec, epoch, nextWrite, flags>>

\* Writers that hold no lease and read and write in one transaction, so they
\* always carry the current revision.  They make what a process read stale.
\*   create  - tx.put(key, value, null), e.g. collections.ts:138
\*   rewrite - rotateRecords: tx.list then tx.put(record.revision)
\*             (index.ts:543-551, maintenance.ts:48-56)
\*   delete  - tx.get/list then tx.delete(record.revision)
\*             (maintenance.ts:76-100, collections.ts:219-232, :250-268)
OtherWriterCreates ==
    /\ WithEnvironment
    /\ rec = NoRecord
    /\ nextWrite < MaxWrites
    /\ rec' = [revision |-> 1, write |-> nextWrite + 1]
    /\ nextWrite' = nextWrite + 1
    /\ UNCHANGED <<now, claim, lock, local, epoch, fenceEpoch,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote>>

OtherWriterRewrites ==
    /\ WithEnvironment
    /\ rec # NoRecord
    /\ nextWrite < MaxWrites
    /\ rec' = [revision |-> rec.revision + 1, write |-> nextWrite + 1]
    /\ nextWrite' = nextWrite + 1
    /\ UNCHANGED <<now, claim, lock, local, epoch, fenceEpoch,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote>>

OtherWriterDeletes ==
    /\ WithEnvironment
    /\ Deletes
    /\ rec # NoRecord
    /\ rec' = NoRecord
    /\ UNCHANGED <<now, claim, lock, local, ghosts>>

\* The clock bound is reached.  Changes nothing; it is here so that the end
\* of the bounded run is not reported as a deadlock.
ClockBoundReached ==
    /\ now = MaxNow
    /\ UNCHANGED vars

Next ==
    \/ ClockTicks
    \/ \E p \in Processes : ReadRecord(p)
    \/ \E p \in Processes : ClaimReadsClock(p)
    \/ \E p \in Processes : ClaimUpsert(p)
    \/ \E p \in Processes : AssertFence(p)
    \/ \E p \in Processes : HeartbeatExtends(p)
    \/ \E p \in Processes : \E release \in BOOLEAN : FencedCommit(p, "put", release)
    \/ \E p \in Processes : \E release \in BOOLEAN : FencedCommit(p, "delete", release)
    \/ \E p \in Processes : FencedCommit(p, "nothing", TRUE)
    \/ CancelKey
    \/ \E p \in Processes : ProcessRestarts(p)
    \/ OtherWriterCreates
    \/ OtherWriterRewrites
    \/ OtherWriterDeletes
    \/ ClockBoundReached

Spec == Init /\ [][Next]_vars

\* The processes are interchangeable, so the checker may treat two states
\* that differ only in which process is which as one state.
Symmetry == Permutations(Processes)

----------------------------------------------------------------------------
\* The rules.  README.md gives each one as a plain sentence.

\* Rule 1.  A transaction that passed assertFence commits only while its
\* fence is still the lease on the key: nobody claimed or cancelled the key
\* since the process got that fence.
StaleFenceNeverCommits == ~staleFenceCommitted

\* Rule 2.  claim() never takes a lease away before it expired.
LiveLeaseNeverTakenOver == ~liveLeaseTakenOver

\* Rule 3.  assertFence refuses a lease that expired, also when nobody took
\* it over.
ExpiredFenceNeverPasses == ~expiredFencePassed

\* Rule 4.  A put or delete with an expectedRevision replaces only the
\* record version that the caller read.
StaleRevisionNeverWrites == ~staleRevisionWrote
=============================================================================
