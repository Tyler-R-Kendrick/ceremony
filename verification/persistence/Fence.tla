------------------------------- MODULE Fence -------------------------------
(***************************************************************************)
(* The lease ("claim") and the revision-checked write on ONE RecordKey of  *)
(* the persistence store, src/server/persistence/index.ts.                 *)
(*                                                                         *)
(* One step of this model is one SQL statement, or a run of statements     *)
(* that no other transaction can come between.  The PostgreSQL backend     *)
(* runs at READ COMMITTED, so two transactions do interleave there; what   *)
(* keeps a fenced transaction whole is the row lock that assertFence       *)
(* takes with SELECT ... FOR UPDATE (index.ts:195, :209).  The SQLite      *)
(* backend runs each transaction under BEGIN IMMEDIATE (index.ts:409), so  *)
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
                     \* one restoreEncryptedBackup into a fresh database
                     \* (index.ts:492-541, :543-590), while the workers keep
                     \* the fences they hold

    \* Each switch below is TRUE in the code as written.  FALSE removes one
    \* check, to show that a rule can fail (the Broken*.cfg files).
    CheckGeneration,      \* index.ts:217  Number(row.generation) !== fence.generation
    CheckExpiry,          \* index.ts:219  Number(row.expires) <= (await now())
    LockFenceRow,         \* index.ts:195  " FOR UPDATE" on the claim row read
    ClaimOnlyExpired,     \* index.ts:364  WHERE ceremony_claims.expires<=$6
    ClaimBumpsGeneration, \* index.ts:364  generation=ceremony_claims.generation+1
    CheckRevision,        \* index.ts:314  AND revision=$6   (and :324 for delete)
    KeepRetired,          \* index.ts:330-335  delete keeps the last revision in
                          \* ceremony_retired, and create starts above it
                          \* (index.ts:223-274)

    \* Each switch below is a check that the code as written does NOT have, so
    \* every config that describes the code as written sets it FALSE.  TRUE is
    \* the check that rules 5, 6 and 7 need.  The Finding*.cfg files state
    \* each of those rules on the code as written; the Broken*.cfg file of
    \* the same rule sets the switch FALSE and must keep breaking once the
    \* check is in the code.
    HeartbeatMatchesFence, \* index.ts:373-376  the heartbeat UPDATE changes
                           \* the row only where generation and worker are the
                           \* fence's, and a heartbeat that changes no row is
                           \* a PersistenceConflict
    ClaimRefusesExpired,   \* index.ts:362-368  claim() never returns a fence
                           \* whose lease ran out before the upsert ran
    RestoreBumpsGeneration \* index.ts:570-573  no generation the restored
                           \* store hands out equals one that a fence from
                           \* before the restore names

VARIABLES
    \* ---- the database ----
    now,      \* the database clock, read by now() (index.ts:196-205)
    claim,    \* the ceremony_claims row of the key (index.ts:167-170)
    lock,     \* which process's open transaction holds the row lock on `claim`
    rec,      \* the ceremony_records row of the key (index.ts:164-166)
    retired,  \* the ceremony_retired row of the key: the revision its record
              \* had when it was deleted (index.ts:171-173)
    life,     \* 0: the store the workers started on; 1: the fresh database
              \* that restoreEncryptedBackup filled (index.ts:543-590)
    backedUp, \* TRUE once encryptedBackup ran (index.ts:492-541)
    backup,   \* the ceremony_claims row of the key in that backup
    \* ---- each worker process ----
    pc,        \* where the process is (see PcValues)
    fence,     \* the Fence that claim() returned to it (index.ts:67, :368)
    clockRead, \* `time` in claim(): the clock value it read (index.ts:362)
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
    restoreEpoch \* the value of `epoch` right after the restore, or 0

store  == <<life, backedUp, backup>>
db     == <<now, claim, lock, rec, retired, store>>
local  == <<pc, fence, clockRead, seen>>
\* The latches of rules 5, 6 and 7.
newFlags == <<foreignLeaseExtended, expiredFenceReturned, oldFencePassedRestore>>
flags  == <<staleFenceCommitted, liveLeaseTakenOver, expiredFencePassed,
            staleRevisionWrote, newFlags>>
ghosts == <<epoch, fenceEpoch, nextWrite, flags, restoreEpoch>>
vars   == <<db, local, ghosts>>

----------------------------------------------------------------------------
\* Rows.  Real generations and revisions start at 1, so 0 stands for
\* "no row" (and, for `seen`, for expectedRevision = null).
NoClaim  == [generation |-> 0, worker |-> "-", expires |-> 0]
NoRecord == [revision |-> 0, write |-> 0]
\* `life` is not a field of the code's Fence: it says which database handed
\* the fence out, which rule 7 is stated on.
NoFence  == [generation |-> 0, worker |-> "-", life |-> 0]
NoLock   == "-"

PcValues == {
    "idle",      \* holds no fence, is in no transaction
    "claiming",  \* inside claim(): read the clock, has not run the upsert
    "working",   \* holds a fence, between transactions (the provider call)
    "asserted"   \* inside a fenced transaction: assertFence() returned
}

\* The `worker` argument of claim().
WorkerOf(p) == IF SharedIdentity THEN "same-workload" ELSE p

\* The row that cancel() leaves (index.ts:379-384).
Cancelled == [generation |-> claim.generation + 1,
              worker     |-> "cancelled",
              expires    |-> 0]

Unlock(p) == IF lock = p THEN NoLock ELSE lock

\* put(key, value, null) (index.ts:223-274): the new record starts one
\* above the revision the key's record had when it was deleted, and the
\* ceremony_retired row goes.  The statements of create are one step: the
\* INSERT waits for a transaction that is deleting the key, and once it
\* holds the new row no other transaction can delete the key, so the second
\* read of ceremony_retired (index.ts:255) sees every delete of the key that
\* committed before the record exists.
CreatedRevision == IF KeepRetired THEN retired + 1 ELSE 1
RetiredAfterCreate == 0
\* delete(key, revision) (index.ts:320-336): the row goes, and its revision
\* stays in ceremony_retired.  The upsert at index.ts:332-335 keeps the higher
\* of two revisions, but a key with a record has no retired row, because
\* create removes it, so the delete always writes the record's revision.
RetiredAfterDelete == IF KeepRetired THEN rec.revision ELSE 0

TypeOK ==
    /\ now \in 0..MaxNow
    /\ claim.generation \in 0..MaxEpoch
    /\ claim.expires \in 0..(MaxNow + Duration)
    /\ lock \in Processes \cup {NoLock}
    /\ rec.revision \in 0..MaxWrites
    /\ rec.write \in 0..MaxWrites
    /\ retired \in 0..MaxWrites
    /\ life \in 0..1
    /\ backedUp \in BOOLEAN
    /\ backup.generation \in 0..MaxEpoch
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
    /\ foreignLeaseExtended \in BOOLEAN
    /\ expiredFenceReturned \in BOOLEAN
    /\ oldFencePassedRestore \in BOOLEAN
    /\ restoreEpoch \in 0..MaxEpoch

Init ==
    /\ now = 0
    /\ claim = NoClaim
    /\ lock = NoLock
    /\ rec = NoRecord
    /\ retired = 0
    /\ life = 0
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

----------------------------------------------------------------------------
\* The database clock moves on.
ClockTicks ==
    /\ now < MaxNow
    /\ now' = now + 1
    /\ UNCHANGED <<claim, lock, rec, retired, store, local, ghosts>>

\* tx.get / tx.list in a transaction of their own, or early in a longer one
\* (index.ts:285-303, :337-357).  The process keeps the revision it read and
\* passes it to a later put/delete, as src/server/agent/workflow-api.ts does
\* with row.revision (:32-39 read, :71 write).
ReadRecord(p) ==
    /\ pc[p] \in {"idle", "working", "asserted"}
    /\ seen[p] # rec
    /\ seen' = [seen EXCEPT ![p] = rec]
    /\ UNCHANGED <<db, pc, fence, clockRead, ghosts>>

\* claim(), first statement: `const time = await now()` (index.ts:362).
ClaimReadsClock(p) ==
    /\ pc[p] = "idle"
    /\ epoch < MaxEpoch
    /\ pc' = [pc EXCEPT ![p] = "claiming"]
    /\ clockRead' = [clockRead EXCEPT ![p] = now]
    /\ UNCHANGED <<db, fence, seen, ghosts>>

\* claim(), second statement, and the COMMIT of its transaction: the upsert
\* INSERT ... ON CONFLICT DO UPDATE ... WHERE expires<=$6 RETURNING generation
\* (index.ts:363-368).  The upsert waits while another transaction holds the
\* row, then decides on the row as committed.  An uncommitted upsert is not
\* visible to anyone, so upsert and COMMIT are one step here.
\* The upsert can wait on the row lock for longer than durationMs, so the
\* lease it writes, time + Duration, can have run out by the time it runs.
\* The code as written returns that fence all the same (rule 6).
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
           ranOut  == time + Duration <= now
       IN IF /\ free \/ lapsed \/ ~ClaimOnlyExpired
             /\ ClaimRefusesExpired => ~ranOut
          THEN /\ claim' = [generation |-> newGeneration,
                            worker     |-> WorkerOf(p),
                            expires    |-> time + Duration]
               /\ fence' = [fence EXCEPT ![p] =
                               [generation |-> newGeneration,
                                worker     |-> WorkerOf(p),
                                life       |-> life]]
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
                              oldFencePassedRestore, restoreEpoch>>
          ELSE \* no row returned: PersistenceConflict (index.ts:367); or,
               \* with ClaimRefusesExpired, a lease that ran out is refused
               \* and the upsert rolls back
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ clockRead' = [clockRead EXCEPT ![p] = 0]
               /\ UNCHANGED <<db, fence, seen, ghosts>>

\* assertFence(): read the claim row and take its row lock, then compare it
\* with the fence and the clock (index.ts:213-222).  It opens the fenced
\* transaction of heartbeat() (index.ts:372) and of every fenced commit
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
                   /\ RestoreBumpsGeneration => fence[p].life = life
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
                              expiredFenceReturned, restoreEpoch>>
          ELSE \* PersistenceConflict (index.ts:221): the lease is lost, the
               \* transaction rolls back, the process stops using the fence
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ fence' = [fence EXCEPT ![p] = NoFence]
               /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = 0]
               /\ UNCHANGED <<db, clockRead, seen, epoch, nextWrite, flags,
                              restoreEpoch>>

\* heartbeat(), after its assertFence: UPDATE ceremony_claims SET expires
\* (index.ts:373-376), then COMMIT.  In the code as written the UPDATE names
\* the key only, not the generation, so it extends whichever row is there;
\* only the row lock of assertFence keeps that row the fence's own (rule 5).
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
                              restoreEpoch>>
          ELSE \* the UPDATE changed no row: PersistenceConflict, ROLLBACK;
               \* the lease is lost, the process stops using the fence
               /\ pc' = [pc EXCEPT ![p] = "idle"]
               /\ fence' = [fence EXCEPT ![p] = NoFence]
               /\ fenceEpoch' = [fenceEpoch EXCEPT ![p] = 0]
               /\ lock' = Unlock(p)
               /\ UNCHANGED <<now, claim, rec, retired, store, clockRead, seen,
                              epoch, nextWrite, flags, restoreEpoch>>

\* The rest of a fenced commit, after its assertFence, up to COMMIT:
\*   write   - tx.put (index.ts:304-319) or tx.delete (index.ts:320-336) with
\*             the revision the process read, or nothing;
\*   release - tx.cancel on the same key (index.ts:379-384), or not.
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
           \* INSERT ... ON CONFLICT DO NOTHING (index.ts:245) when null,
           \* UPDATE/DELETE ... AND revision=$n (index.ts:314, :324) otherwise
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
                              expiredFencePassed, newFlags, restoreEpoch>>
          ELSE \* PersistenceConflict (index.ts:254, :317, :329), then ROLLBACK
               \* (index.ts:440, :634): nothing is written, the lease stays
               /\ pc' = [pc EXCEPT ![p] = "working"]
               /\ lock' = Unlock(p)
               /\ UNCHANGED <<now, claim, rec, retired, store, fence, clockRead,
                              seen, ghosts>>

\* tx.cancel(key) by a caller that holds no fence, such as a person
\* cancelling the run (src/server/commands.ts:436).  One upsert (index.ts:381).
CancelKey ==
    /\ lock = NoLock
    /\ epoch < MaxEpoch
    /\ claim' = Cancelled
    /\ epoch' = epoch + 1
    /\ UNCHANGED <<now, lock, rec, retired, store, local, fenceEpoch, nextWrite,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote, newFlags,
                   restoreEpoch>>

\* The process stops or restarts: its open transaction rolls back
\* (index.ts:440, :634) and what it held in memory is gone.  The claim row
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
                   restoreEpoch>>

\* Writers that hold no lease and read and write in one transaction, so they
\* always carry the current revision.  They make what a process read stale.
\*   create  - tx.put(key, value, null), e.g. collections.ts:134
\*   rewrite - rotateRecords: tx.list then tx.put(record.revision)
\*             (index.ts:654-662, maintenance.ts:47-56)
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
                   restoreEpoch>>

OtherWriterRewrites ==
    /\ WithEnvironment
    /\ rec # NoRecord
    /\ nextWrite < MaxWrites
    /\ rec' = [revision |-> rec.revision + 1, write |-> nextWrite + 1]
    /\ nextWrite' = nextWrite + 1
    /\ UNCHANGED <<now, claim, lock, retired, store, local, epoch, fenceEpoch,
                   staleFenceCommitted, liveLeaseTakenOver,
                   expiredFencePassed, staleRevisionWrote, newFlags,
                   restoreEpoch>>

OtherWriterDeletes ==
    /\ WithEnvironment
    /\ Deletes
    /\ rec # NoRecord
    /\ rec' = NoRecord
    /\ retired' = RetiredAfterDelete
    /\ UNCHANGED <<now, claim, lock, store, local, ghosts>>

\* encryptedBackup() (index.ts:492-541): one transaction that locks every
\* table, so no transaction of a worker is open, and that refuses a live
\* lease (index.ts:494-497).  It copies the claim row's generation.
TakeBackup ==
    /\ Restores
    /\ ~backedUp
    /\ lock = NoLock
    /\ \A p \in Processes : pc[p] \notin {"claiming", "asserted"}
    /\ claim = NoClaim \/ claim.expires <= now
    /\ backedUp' = TRUE
    /\ backup' = claim
    /\ UNCHANGED <<now, claim, lock, rec, retired, life, local, ghosts>>

\* restoreEncryptedBackup() into a fresh database (index.ts:543-590), which
\* the workers then use with the fences they still hold.  The workers can
\* go on claiming on the old store after the backup, so their fences can
\* name generations the backup never saw.  The code as written writes each
\* claim row of the backup with generation + 1, worker 'restored' and
\* expires 0 (index.ts:570-573), and a key with no row in the backup has
\* none.  Records are left as they are: rule 7 is about the lease only.
RestoreBackup ==
    /\ Restores
    /\ backedUp
    /\ life = 0
    /\ epoch < MaxEpoch
    /\ lock = NoLock
    /\ \A p \in Processes : pc[p] \notin {"claiming", "asserted"}
    /\ claim' = IF backup = NoClaim THEN NoClaim
                ELSE [generation |-> backup.generation + 1,
                      worker     |-> "restored",
                      expires    |-> 0]
    /\ life' = 1
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

\* Rule 7.  After a restore, assertFence refuses every fence the store
\* handed out before it.
RestoredStoreRefusesOldFences == ~oldFencePassedRestore
=============================================================================
