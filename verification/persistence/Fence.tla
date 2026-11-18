------------------------------- MODULE Fence -------------------------------
(***************************************************************************)
(* The lease ("claim") and the revision-checked write on ONE RecordKey of  *)
(* the persistence store, src/server/persistence/index.ts.                 *)
(*                                                                         *)
(* One step of this model is one SQL statement, or a run of statements     *)
(* that no other transaction can come between.  The PostgreSQL backend     *)
(* runs at READ COMMITTED, so two transactions do interleave there; what   *)
(* keeps a fenced transaction whole is the row lock that assertFence       *)
(* takes with SELECT ... FOR UPDATE (index.ts:241, :250).  The SQLite      *)
(* backend runs each transaction under BEGIN IMMEDIATE (index.ts:476), so  *)
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
    Restores,        \* scope: TRUE adds one encryptedBackup of the store and
                     \* two restoreEncryptedBackup of it, each into a fresh
                     \* database (index.ts:559-624, :626-695), while the
                     \* workers keep the fences they hold

    \* Each switch below is TRUE in the code as written.  FALSE removes one
    \* check, to show that a rule can fail (the Broken*.cfg files).
    CheckGeneration,      \* index.ts:258  Number(row.generation) !== fence.generation
    CheckExpiry,          \* index.ts:260  Number(row.expires) <= (await now())
    LockFenceRow,         \* index.ts:241  " FOR UPDATE" on the claim row read
    ClaimOnlyExpired,     \* index.ts:411  WHERE ceremony_claims.expires<=$6
    ClaimBumpsGeneration, \* index.ts:411  generation=ceremony_claims.generation+1
    CheckRevision,        \* index.ts:355  AND revision=$6   (and :365 for delete)
    KeepRetired,          \* index.ts:371-376  delete keeps the last revision in
                          \* ceremony_retired, and create starts above it
                          \* (index.ts:264-315)
    HeartbeatMatchesFence, \* index.ts:432-441  the heartbeat UPDATE changes
                           \* the row only where generation and worker are the
                           \* fence's (AND generation=$5 AND worker=$6), and a
                           \* heartbeat that changes no row is a
                           \* PersistenceConflict
    ClaimLeaseFromUpsert,  \* index.ts:410-413  the lease claim() writes runs
                           \* from the database clock when the row is written
                           \* (${clock}+$5), not from `time`
    RestoreBumpsGeneration, \* index.ts:643-681  the restored store's lease
                           \* base is above every generation of the store the
                           \* backup came from, and every generation it hands
                           \* out is that base plus a count (index.ts:214,
                           \* :411, :448, :681)
    RestoreEpochFromClock  \* index.ts:648-665  the restored store's lease
                           \* epoch is the second of the database clock the
                           \* restore runs in, once that is above the epoch of
                           \* the store the backup came from; not the
                           \* source's epoch + 1, which every restore of one
                           \* backup would share

VARIABLES
    \* ---- the database ----
    now,      \* the database clock, read by now() (index.ts:242-246)
    claim,    \* the ceremony_claims row of the key (index.ts:204-207)
    lock,     \* which process's open transaction holds the row lock on `claim`
    rec,      \* the ceremony_records row of the key (index.ts:201-203)
    retired,  \* the ceremony_retired row of the key: the revision its record
              \* had when it was deleted (index.ts:208-210)
    life,     \* 0: the store the workers started on; 1 and 2: the fresh
              \* databases that the first and the second
              \* restoreEncryptedBackup filled (index.ts:626-695)
    leaseEpoch, \* the lease epoch of the store in use: the row of
                \* ceremony_lease_base over leaseSpan, or 0 (index.ts:214)
    backedUp, \* TRUE once encryptedBackup ran (index.ts:559-624)
    backup,   \* the ceremony_claims row of the key in that backup
    \* ---- each worker process ----
    pc,        \* where the process is (see PcValues)
    fence,     \* the Fence that claim() returned to it (index.ts:67, :425)
    clockRead, \* `time` in claim(): the clock value it read (index.ts:403)
    seen,      \* the StoredRecord it last read; its expectedRevision
    \* ---- ghosts: history the rules are stated on; no code stores these ----
    epoch,      \* how many times the lease changed hands (claim or cancel)
    fenceEpoch, \* the value of `epoch` when the process got its fence
    nextWrite,  \* how many record versions were written so far
    staleFenceCommitted, \* latches TRUE when rule 1 breaks
    liveLeaseTakenOver,  \* latches TRUE when rule 2 breaks
    expiredFencePassed,  \* latches TRUE when rule 3 breaks
    staleRevisionWrote,  \* latches TRUE when rule 4 breaks
    foreignLeaseExtended,  \* latches TRUE when rule 5 breaks
    expiredFenceReturned,  \* latches TRUE when rule 6 breaks
    oldFencePassedRestore, \* latches TRUE when rule 7 breaks
    restoreEpoch, \* the value of `epoch` right after the last restore, or 0
    restoredAt    \* the clock when the last restore ran, or 0

store  == <<life, leaseEpoch, backedUp, backup>>
db     == <<now, claim, lock, rec, retired, store>>
local  == <<pc, fence, clockRead, seen>>
\* The latches of rules 5, 6 and 7.
newFlags == <<foreignLeaseExtended, expiredFenceReturned, oldFencePassedRestore>>
flags  == <<staleFenceCommitted, liveLeaseTakenOver, expiredFencePassed,
            staleRevisionWrote, newFlags>>
ghosts == <<epoch, fenceEpoch, nextWrite, flags, restoreEpoch, restoredAt>>
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

\* The store's lease base: its lease epoch times leaseSpan (index.ts:124,
\* :214).  In the code a generation is the base plus a count of the key's
\* claims and cancels below leaseSpan, and a claim that would reach it is
\* refused (index.ts:411, :414-423); here the count of a store stays at most
\* MaxEpoch, so Span = MaxEpoch + 1 stands for leaseSpan and that refusal
\* never comes up.
Span == MaxEpoch + 1
LeaseBase == leaseEpoch * Span
\* The lease epoch a restore gives the fresh store (index.ts:643-665).  A
\* store that was never restored has epoch 0, and the backup here is always
\* of that store.  The restore reads the second of the database clock, here
\* `now`, and waits until it is above the source's epoch (index.ts:657-664).
\* With RestoreEpochFromClock FALSE the epoch is the source's epoch + 1, the
\* same for both restores; with RestoreBumpsGeneration FALSE the restored
\* store keeps epoch 0.
RestoredEpoch == IF ~RestoreBumpsGeneration THEN 0
                 ELSE IF RestoreEpochFromClock THEN now
                 ELSE 1
\* Every generation a row can hold.
Generations == 0..((MaxNow + 1) * Span)

\* The row that cancel() leaves (index.ts:444-451): a key with no row gets
\* the base + 1 (index.ts:448).
Cancelled == [generation |-> IF claim = NoClaim THEN LeaseBase + 1
                             ELSE claim.generation + 1,
              worker     |-> "cancelled",
              expires    |-> 0]

Unlock(p) == IF lock = p THEN NoLock ELSE lock

\* put(key, value, null) (index.ts:264-315): the new record starts one
\* above the revision the key's record had when it was deleted, and the
\* ceremony_retired row goes.  The statements of create are one step: the
\* INSERT waits for a transaction that is deleting the key, and once it
\* holds the new row no other transaction can delete the key, so the second
\* read of ceremony_retired (index.ts:296) sees every delete of the key that
\* committed before the record exists.
CreatedRevision == IF KeepRetired THEN retired + 1 ELSE 1
RetiredAfterCreate == 0
\* delete(key, revision) (index.ts:361-377): the row goes, and its revision
\* stays in ceremony_retired.  The upsert at index.ts:373-376 keeps the higher
\* of two revisions, but a key with a record has no retired row, because
\* create removes it, so the delete always writes the record's revision.
RetiredAfterDelete == IF KeepRetired THEN rec.revision ELSE 0

TypeOK ==
    /\ now \in 0..MaxNow
    /\ claim.generation \in Generations
    /\ claim.expires \in 0..(MaxNow + Duration)
    /\ lock \in Processes \cup {NoLock}
    /\ rec.revision \in 0..MaxWrites
    /\ rec.write \in 0..MaxWrites
    /\ retired \in 0..MaxWrites
    /\ life \in 0..2
    /\ leaseEpoch \in 0..MaxNow
    /\ backedUp \in BOOLEAN
    /\ backup.generation \in Generations
    /\ pc \in [Processes -> PcValues]
    /\ \A p \in Processes :
          /\ fence[p].generation \in Generations
          /\ clockRead[p] \in 0..MaxNow
          /\ seen[p].revision \in 0..MaxWrites
          /\ fenceEpoch[p] \in 0..MaxEpoch
    /\ epoch \in 0..MaxEpoch
    /\ nextWrite \in 0..MaxWrites
    /\ staleFenceCommitted \in BOOLEAN
    /\ liveLeaseTakenOver \in BOOLEAN
    /\ expiredFencePassed \in BOOLEAN
    /\ staleRevisionWrote \in BOOLEAN
    /\ foreignLeaseExtended \in BOOLEAN
    /\ expiredFenceReturned \in BOOLEAN
    /\ oldFencePassedRestore \in BOOLEAN
    /\ restoreEpoch \in 0..MaxEpoch
    /\ restoredAt \in 0..MaxNow

Init ==
    /\ now = 0
    /\ claim = NoClaim
    /\ lock = NoLock
    /\ rec = NoRecord
    /\ retired = 0
    /\ life = 0
    /\ leaseEpoch = 0
    /\ backedUp = FALSE
    /\ backup = NoClaim
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
    /\ foreignLeaseExtended = FALSE
    /\ expiredFenceReturned = FALSE
    /\ oldFencePassedRestore = FALSE
    /\ restoreEpoch = 0
    /\ restoredAt = 0

----------------------------------------------------------------------------
\* The database clock moves on.
ClockTicks ==
    /\ now < MaxNow
    /\ now' = now + 1
    /\ UNCHANGED <<claim, lock, rec, retired, store, local, ghosts>>

\* tx.get / tx.list in a transaction of their own, or early in a longer one
\* (index.ts:326-344, :378-398).  The process keeps the revision it read and
\* passes it to a later put/delete, as src/server/agent/workflow-api.ts does
\* with row.revision (:31-38 read, :70 write).
ReadRecord(p) ==
    /\ pc[p] \in {"idle", "working", "asserted"}
    /\ seen[p] # rec
    /\ seen' = [seen EXCEPT ![p] = rec]
    /\ UNCHANGED <<db, pc, fence, clockRead, ghosts>>

\* claim(), first statement: `const time = await now()` (index.ts:403).
ClaimReadsClock(p) ==
    /\ pc[p] = "idle"
    /\ epoch < MaxEpoch
    /\ pc' = [pc EXCEPT ![p] = "claiming"]
    /\ clockRead' = [clockRead EXCEPT ![p] = now]
    /\ UNCHANGED <<db, fence, seen, ghosts>>

\* claim(), second statement, and the COMMIT of its transaction: the upsert
\* INSERT ... ON CONFLICT DO UPDATE ... WHERE expires<=$6 RETURNING generation
\* (index.ts:410-425).  The upsert waits while another transaction holds the
\* row, then decides on the row as committed.  An uncommitted upsert is not
\* visible to anyone, so upsert and COMMIT are one step here.
\* The upsert can run long after `time` was read, for longer than durationMs.
\* `time` decides whether the lease on the row ran out ($6); the lease it
\* writes runs from the clock at the upsert, ${clock}+$5 in both the INSERT
\* and the UPDATE, so it has not run out when claim() returns it (rule 6).
\* With ClaimLeaseFromUpsert FALSE it is time + Duration, which can have
\* run out by then.
ClaimUpsert(p) ==
    /\ pc[p] = "claiming"
    /\ lock = NoLock
    /\ epoch < MaxEpoch
    /\ LET time    == clockRead[p]
           free    == claim = NoClaim
           lapsed  == claim.expires <= time
           newGeneration ==
               IF free THEN LeaseBase + 1
               ELSE IF ClaimBumpsGeneration THEN claim.generation + 1
               ELSE claim.generation
           leaseEnd == IF ClaimLeaseFromUpsert THEN now + Duration
                       ELSE time + Duration
           ranOut  == leaseEnd <= now
       IN IF free \/ lapsed \/ ~ClaimOnlyExpired
          THEN /\ claim' = [generation |-> newGeneration,
                            worker     |-> WorkerOf(p),
                            expires    |-> leaseEnd]
               /\ fence' = [fence EXCEPT ![p] =
                               [generation |-> newGeneration,
                                worker     |-> WorkerOf(p)]]
               /\ pc' = [pc EXCEPT ![p] = "working"]
               /\ epoch' = epoch + 1
               /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = epoch + 1]
               \* Rule 2 looks at the clock as it is now, not at `time`.
               /\ liveLeaseTakenOver' =
                      (liveLeaseTakenOver \/ (~free /\ claim.expires > now))
               /\ expiredFenceReturned' = (expiredFenceReturned \/ ranOut)
               /\ clockRead' = [clockRead EXCEPT ![p] = 0]
               /\ UNCHANGED <<now, lock, rec, retired, store, seen, nextWrite,
                              staleFenceCommitted, expiredFencePassed,
                              staleRevisionWrote, foreignLeaseExtended,
                              oldFencePassedRestore, restoreEpoch, restoredAt>>
          ELSE \* no row returned: PersistenceConflict (index.ts:423)
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ clockRead' = [clockRead EXCEPT ![p] = 0]
               /\ UNCHANGED <<db, fence, seen, ghosts>>

\* assertFence(): read the claim row and take its row lock, then compare it
\* with the fence and the clock (index.ts:254-263).  It opens the fenced
\* transaction of heartbeat() (index.ts:429) and of every fenced commit
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
               \* A fence got before the restore passes on the restored store.
               /\ oldFencePassedRestore' =
                      (oldFencePassedRestore \/ fenceEpoch[p] < restoreEpoch)
               /\ UNCHANGED <<now, claim, rec, retired, store, fence, clockRead,
                              seen, epoch, fenceEpoch, nextWrite,
                              staleFenceCommitted, liveLeaseTakenOver,
                              staleRevisionWrote, foreignLeaseExtended,
                              expiredFenceReturned, restoreEpoch, restoredAt>>
          ELSE \* PersistenceConflict (index.ts:262): the lease is lost, the
               \* transaction rolls back, the process stops using the fence
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ fence' = [fence EXCEPT ![p] = NoFence]
               /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = 0]
               /\ UNCHANGED <<db, clockRead, seen, epoch, nextWrite, flags,
                              restoreEpoch, restoredAt>>

\* heartbeat(), after its assertFence: UPDATE ceremony_claims SET expires
\* ... AND generation=$5 AND worker=$6 (index.ts:432-441), then COMMIT.  The
\* UPDATE changes the row only where it is still the fence's lease, so it
\* keeps to the fence's own lease also where no row lock keeps the row still
\* (rule 5); a heartbeat that changes no row is a PersistenceConflict
\* (index.ts:441).  With HeartbeatMatchesFence FALSE the UPDATE names the key
\* only, and only the row lock of assertFence keeps that row the fence's own.
HeartbeatExtends(p) ==
    /\ pc[p] = "asserted"
    /\ LET own == /\ claim.generation = fence[p].generation
                  /\ claim.worker = fence[p].worker
       IN IF HeartbeatMatchesFence => own
          THEN /\ claim' = [claim EXCEPT !.expires = now + Duration]
               /\ staleFenceCommitted' =
                      (staleFenceCommitted \/ fenceEpoch[p] # epoch)
               /\ foreignLeaseExtended' =
                      (foreignLeaseExtended \/ fenceEpoch[p] # epoch)
               /\ lock' = Unlock(p)
               /\ pc' = [pc EXCEPT ![p] = "working"]
               /\ UNCHANGED <<now, rec, retired, store, fence, clockRead, seen,
                              epoch, fenceEpoch, nextWrite, liveLeaseTakenOver,
                              expiredFencePassed, staleRevisionWrote,
                              expiredFenceReturned, oldFencePassedRestore,
                              restoreEpoch, restoredAt>>
          ELSE \* the UPDATE changed no row: PersistenceConflict, ROLLBACK;
               \* the lease is lost, the process stops using the fence
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ fence' = [fence EXCEPT ![p] = NoFence]
               /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = 0]
               /\ lock' = Unlock(p)
               /\ UNCHANGED <<now, claim, rec, retired, store, clockRead, seen,
                              epoch, nextWrite, flags, restoreEpoch, restoredAt>>

\* The rest of a fenced commit, after its assertFence, up to COMMIT:
\*   write   - tx.put (index.ts:345-360) or tx.delete (index.ts:361-377) with
\*             the revision the process read, or nothing;
\*   release - tx.cancel on the same key (index.ts:444-451), or not.
\* workflow-api.ts:68-73 is put-or-nothing with release; a2h.ts:80-84 is put
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
           \* INSERT ... ON CONFLICT DO NOTHING (index.ts:286) when null,
           \* UPDATE/DELETE ... AND revision=$n (index.ts:355, :365) otherwise
           rowMatches ==
               IF expected = 0 THEN rec = NoRecord
               ELSE /\ rec # NoRecord
                    /\ CheckRevision => rec.revision = expected
           written == IF write = "put"
                      THEN [revision |-> IF expected = 0 THEN CreatedRevision
                                         ELSE expected + 1,
                            write    |-> nextWrite + 1]
                      ELSE NoRecord
       IN IF write = "nothing" \/ rowMatches
          THEN /\ rec' = IF write = "nothing" THEN rec ELSE written
               /\ retired' = CASE write = "delete" -> RetiredAfterDelete
                               [] write = "put" /\ expected = 0 ->
                                      RetiredAfterCreate
                               [] OTHER -> retired
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
               /\ UNCHANGED <<now, store, clockRead, liveLeaseTakenOver,
                              expiredFencePassed, newFlags, restoreEpoch, restoredAt>>
          ELSE \* PersistenceConflict (index.ts:295, :358, :370), then ROLLBACK
               \* (index.ts:507, :742): nothing is written, the lease stays
               /\ pc' = [pc EXCEPT ![p] = "working"]
               /\ lock' = Unlock(p)
               /\ UNCHANGED <<now, claim, rec, retired, store, fence, clockRead,
                              seen, ghosts>>

\* tx.cancel(key) by a caller that holds no fence, such as a person
\* cancelling the run (src/server/commands.ts:436).  One upsert (index.ts:448).
CancelKey ==
    /\ lock = NoLock
    /\ epoch < MaxEpoch
    /\ claim' = Cancelled
    /\ epoch' = epoch + 1
    /\ UNCHANGED <<now, lock, rec, retired, store, local, fenceEpoch, nextWrite,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote, newFlags,
                   restoreEpoch, restoredAt>>

\* The process stops or restarts: its open transaction rolls back
\* (index.ts:507, :742) and what it held in memory is gone.  The claim row
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
    /\ UNCHANGED <<now, claim, rec, retired, store, epoch, nextWrite, flags,
                   restoreEpoch, restoredAt>>

\* Writers that hold no lease and read and write in one transaction, so they
\* always carry the current revision.  They make what a process read stale.
\*   create  - tx.put(key, value, null), e.g. collections.ts:134
\*   rewrite - rotateRecords: tx.list then tx.put(record.revision)
\*             (index.ts:762-770, maintenance.ts:47-56)
\*   delete  - tx.get/list then tx.delete(record.revision)
\*             (maintenance.ts:71-100, collections.ts:214-232, :248-268)
OtherWriterCreates ==
    /\ WithEnvironment
    /\ rec = NoRecord
    /\ nextWrite < MaxWrites
    /\ rec' = [revision |-> CreatedRevision, write |-> nextWrite + 1]
    /\ retired' = RetiredAfterCreate
    /\ nextWrite' = nextWrite + 1
    /\ UNCHANGED <<now, claim, lock, store, local, epoch, fenceEpoch,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote, newFlags,
                   restoreEpoch, restoredAt>>

OtherWriterRewrites ==
    /\ WithEnvironment
    /\ rec # NoRecord
    /\ nextWrite < MaxWrites
    /\ rec' = [revision |-> rec.revision + 1, write |-> nextWrite + 1]
    /\ nextWrite' = nextWrite + 1
    /\ UNCHANGED <<now, claim, lock, retired, store, local, epoch, fenceEpoch,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote, newFlags,
                   restoreEpoch, restoredAt>>

OtherWriterDeletes ==
    /\ WithEnvironment
    /\ Deletes
    /\ rec # NoRecord
    /\ rec' = NoRecord
    /\ retired' = RetiredAfterDelete
    /\ UNCHANGED <<now, claim, lock, store, local, ghosts>>

\* encryptedBackup() (index.ts:559-624): one transaction that locks every
\* table (index.ts:707), so no transaction of a worker is open, and that
\* refuses a live lease (index.ts:561-564).  It copies the claim row's
\* generation (index.ts:581-590) and the store's lease base (index.ts:602-618).
TakeBackup ==
    /\ Restores
    /\ ~backedUp
    /\ lock = NoLock
    /\ \A p \in Processes : pc[p] \notin {"claiming", "asserted"}
    /\ claim = NoClaim \/ claim.expires <= now
    /\ backedUp' = TRUE
    /\ backup' = claim
    /\ UNCHANGED <<now, claim, lock, rec, retired, life, leaseEpoch, local, ghosts>>

\* restoreEncryptedBackup() of the one backup into a fresh database
\* (index.ts:626-695), which the workers then use with the fences they still
\* hold.  It runs twice at most: the first restored store can be lost before
\* anyone backs it up, and the same backup restored again, while workers
\* still hold fences of the first restored store.  The workers can go on
\* claiming on a store after the backup, so their fences can name
\* generations the backup never saw.  The restore writes the new lease base
\* (index.ts:643-672) and each claim row of the backup with the base + 1,
\* worker 'restored' and expires 0 (index.ts:678-681); a key with no row in
\* the backup has none, and its first claim or cancel starts at the base + 1.
\* With RestoreBumpsGeneration FALSE the row is at the backup's generation + 1
\* and the base stays 0.  Records are left as they are: rule 7 is about the
\* lease only.
RestoreBackup ==
    /\ Restores
    /\ backedUp
    /\ life < 2
    \* Not the code but an assumption (README.md, Assumptions): the second
    \* restore runs in a later second of the clock than the first.
    /\ life = 1 => now > restoredAt
    \* The restore waits until the second of the clock is above the source's
    \* epoch, 0 (index.ts:657-664).
    /\ RestoreBumpsGeneration /\ RestoreEpochFromClock => now > 0
    /\ epoch < MaxEpoch
    /\ lock = NoLock
    /\ \A p \in Processes : pc[p] \notin {"claiming", "asserted"}
    /\ claim' = IF backup = NoClaim THEN NoClaim
                ELSE [generation |-> IF RestoreBumpsGeneration
                                     THEN RestoredEpoch * Span + 1
                                     ELSE backup.generation + 1,
                      worker     |-> "restored",
                      expires    |-> 0]
    /\ life' = life + 1
    /\ leaseEpoch' = RestoredEpoch
    /\ restoredAt' = now
    \* Every fence held before the restore is of an earlier lease.
    /\ epoch' = epoch + 1
    /\ restoreEpoch' = epoch + 1
    /\ UNCHANGED <<now, lock, rec, retired, backedUp, backup, local,
                   fenceEpoch, nextWrite, flags>>

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
    \/ TakeBackup
    \/ RestoreBackup
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

\* Rule 5.  A heartbeat extends only the lease its fence names, also when
\* no row lock keeps the claim row still between assertFence and the
\* UPDATE.
HeartbeatExtendsOnlyOwnLease == ~foreignLeaseExtended

\* Rule 6.  claim() never returns a fence whose lease already ran out.
ClaimNeverReturnsExpiredFence == ~expiredFenceReturned

\* Rule 7.  After a restore, assertFence refuses every fence handed out
\* before it, on the store the backup came from or on a store restored
\* earlier from the same backup.
RestoredStoreRefusesOldFences == ~oldFencePassedRestore
=============================================================================
