------------------------------ MODULE Commands ------------------------------
(***************************************************************************)
(* Protected command execution and recovery: the life of the commands sent *)
(* for ONE step (node) of ONE run, in src/server/commands.ts.              *)
(*                                                                         *)
(* Each action below is one store transaction of ProtectedCommandService,  *)
(* or one stretch of work between two transactions. Line numbers are       *)
(* src/server/commands.ts at the sync commit named in                      *)
(* .claude/skills/verify-commands/SKILL.md. README.md in this folder has   *)
(* the full table.                                                         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Commands,          \* the commandIds callers send for the step
  MaxRevalidations,  \* how many times revalidate() may start (a bound)

  \* Broken variants. FALSE is the code as written.
  TakeoverRerunsHandler, \* the takeover branch (723-797) admits a new worker
                         \* for the command instead of recording `uncertain`
  HandlerBeforeIntent,   \* the command and effect records (872-886) are not
                         \* written before the handler call (923)
  SkipAssertFence,       \* the commit drops `await tx.assertFence(fence)` (968)
  AdmitIgnoresHolder,    \* admission does not read the command named on the
                         \* step (833-842)
  TakeoverIgnoresStep,   \* the takeover writes the step `uncertain` without
                         \* reading it first (728-731, 742-752)

  \* Sketches of guards the findings point at. FALSE is the code as written.
  \* They are not product code and nobody has reviewed them as a design.
  ReconcileInAnyRun,        \* the takeover branch drops `run.status ===
                            \* "active"` from its condition (711)
  RevalidateKeepsUncertain  \* revalidate leaves an `uncertain` step alone (545-554)

VARIABLES
  \* What the store holds.
  runStatus,  \* RunRecord.status
  runRev,     \* the revision of the run record
  node,       \* the step's NodeRecord, see NodeStates
  holder,     \* NodeRecord.command: the command admitted last for the step,
              \* "none" = no record or no such field
  cmd,        \* cmd[c]: CommandRecord.state of command c, "none" = no record
  outbox,     \* commands with an outbox entry `reconciliation:<commandId>`
  lease,      \* who holds a live claim on the run: a command's worker,
              \* "revalidation", or "free" (never claimed, cancelled, expired)

  \* What one execute() call holds in memory once it is admitted. A crash
  \* loses it.
  worker,     \* "none" | "admitted" (holds the fence, handler not called)
              \* | "ran" (has a result, not committed) | "gone"
  result,     \* the result that worker holds
  expRev,     \* command.expectedRevision

  \* One revalidate() call.
  reval,      \* "idle" | "checking" (between its two transactions)
  revalRev,   \* the run revision it read
  revalLeft,  \* bound: starts left

  \* History, kept only to state the rules.
  calls,      \* calls[c]: times the handler was called for c (2 = twice or more)
  blind,      \* a handler call was a blind repeat, see CallHandler
  rejected,   \* complete commands whose step a revalidation rejected later
  superseded, \* workers whose lease another party has taken since
  lateCommit  \* a superseded worker recorded its result

vars == << runStatus, runRev, node, holder, cmd, outbox, lease, worker, result,
           expRev, reval, revalRev, revalLeft, calls, blind, rejected,
           superseded, lateCommit >>

(***************************************************************************)
(* The step's NodeRecord, as one word:                                     *)
(*   "pending"   no record, or a record with no `state`: admission       *)
(*               names the command on a step with no record (875-881)  *)
(*   "complete"  {state: "complete", verified: true}                       *)
(*   "waiting"   {state: "awaiting-human" or "verifying", verified: false} *)
(*   "failed"    {state: "failed", verified: false}, may be attempted      *)
(*   "exhausted" {state: "failed", verified: false, exhausted: true}       *)
(*   "uncertain" {state: "uncertain", verified: false}                     *)
(* The service writes `verified: true` only with state "complete", and     *)
(* turns a complete result that fails verification into "failed"           *)
(* (925-936, 953-960), so no other combination is ever stored.             *)
(***************************************************************************)
NodeStates == {"pending", "complete", "waiting", "failed", "exhausted", "uncertain"}

\* OperationResult.state after verification and success criteria (923-962).
Results == {"complete", "waiting", "failed", "uncertain"}

CmdStates == {"none", "running"} \cup Results

InFlight == {c \in Commands : worker[c] \in {"admitted", "ran"}}

\* The command named on the step is still `running` (833-842).
HolderRunning == holder # "none" /\ cmd[holder] = "running"

TypeOK ==
  /\ runStatus \in {"active", "cancelled", "complete"}
  /\ runRev \in Nat
  /\ node \in NodeStates
  /\ holder \in Commands \cup {"none"}
  /\ cmd \in [Commands -> CmdStates]
  /\ outbox \subseteq Commands
  /\ lease \in Commands \cup {"revalidation", "free"}
  /\ worker \in [Commands -> {"none", "admitted", "ran", "gone"}]
  /\ result \in [Commands -> Results \cup {"none"}]
  /\ expRev \in [Commands -> Nat]
  /\ reval \in {"idle", "checking"}
  /\ revalRev \in Nat
  /\ revalLeft \in 0..MaxRevalidations
  /\ calls \in [Commands -> 0..2]
  /\ blind \in BOOLEAN
  /\ rejected \subseteq Commands
  /\ superseded \subseteq Commands
  /\ lateCommit \in BOOLEAN

\* createRun (364-366) stores the run at revision 1; nothing else exists.
Init ==
  /\ runStatus = "active"
  /\ runRev = 1
  /\ node = "pending"
  /\ holder = "none"
  /\ cmd = [c \in Commands |-> "none"]
  /\ outbox = {}
  /\ lease = "free"
  /\ worker = [c \in Commands |-> "none"]
  /\ result = [c \in Commands |-> "none"]
  /\ expRev = [c \in Commands |-> 0]
  /\ reval = "idle"
  /\ revalRev = 0
  /\ revalLeft = MaxRevalidations
  /\ calls = [c \in Commands |-> 0]
  /\ blind = FALSE
  /\ rejected = {}
  /\ superseded = {}
  /\ lateCommit = FALSE

(***************************************************************************)
(* execute(), admission transaction (683-897), no record for this          *)
(* commandId yet (810-896). It refuses while the command named on the step *)
(* is `running` (833-842), claims the run's lease, writes the command and  *)
(* effect records, and names the command on the step's node record         *)
(* (872-886). It does NOT write the run record, and the step's `state` is  *)
(* kept, so the run revision and the step's state stay as they were.       *)
(***************************************************************************)
Admit(c) ==
  /\ cmd[c] = "none"                           \* 705-708: no prior record
  /\ worker[c] \notin {"admitted", "ran"}      \* only bites with HandlerBeforeIntent
  /\ runStatus = "active"                      \* 810-814, and the caller sends
                                               \* the revision it last read
  /\ node \in {"pending", "waiting", "failed"} \* 823-832
  /\ AdmitIgnoresHolder \/ ~HolderRunning      \* 833-842
  /\ lease = "free"                            \* 859-863: tx.claim
  /\ lease' = c
  /\ holder' = c                               \* 875-881
  /\ cmd' = IF HandlerBeforeIntent THEN cmd    \* 872-886: command "running",
            ELSE [cmd EXCEPT ![c] = "running"] \* effect "intent-persisted"
  /\ worker' = [worker EXCEPT ![c] = "admitted"]
  /\ expRev' = [expRev EXCEPT ![c] = runRev]
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << runStatus, runRev, node, outbox, result, reval, revalRev,
                  revalLeft, calls, blind, rejected, lateCommit >>

(***************************************************************************)
(* Between the transactions (919-962): the handler, its verification and   *)
(* the success criteria. The store is not touched. A handler call is a     *)
(* blind repeat when the step is recorded complete, or when another        *)
(* command's call for the step has an unknown outcome: its command is      *)
(* still `running`, or `uncertain`.                                        *)
(***************************************************************************)
CallHandler(c, r) ==
  /\ worker[c] = "admitted"
  /\ calls' = [calls EXCEPT ![c] = IF @ < 2 THEN @ + 1 ELSE @]  \* 923
  /\ blind' = \/ blind
              \/ node = "complete"
              \/ \E d \in Commands \ {c} :
                   calls[d] > 0 /\ cmd[d] \in {"running", "uncertain"}
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = r]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, expRev,
                  reval, revalRev, revalLeft, rejected, superseded,
                  lateCommit >>

\* Authorization is withdrawn or the call is aborted just before the handler
\* (920-922): the catch (937-940) makes the result `uncertain`, no call made.
HandlerNotCalled(c) ==
  /\ worker[c] = "admitted"
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = "uncertain"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, expRev,
                  reval, revalRev, revalLeft, calls, blind, rejected,
                  superseded, lateCommit >>

\* The process dies, or authorization is withdrawn after the handler
\* (963-964, 970-977). Nothing is written and the lease is not released.
WorkerLost(c) ==
  /\ worker[c] \in {"admitted", "ran"}
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, result,
                  expRev, reval, revalRev, revalLeft, calls, blind, rejected,
                  superseded, lateCommit >>

CanCommit(c) ==
  /\ SkipAssertFence \/ lease = c                 \* 968: tx.assertFence
  /\ runStatus = "active" /\ runRev = expRev[c]   \* 978-982

(***************************************************************************)
(* execute(), commit transaction (965-1124): node, command, effect and run *)
(* records are written together, then the lease is released (1115).        *)
(***************************************************************************)
Commit(c) ==
  /\ worker[c] = "ran"
  /\ CanCommit(c)
  /\ \E n \in (IF result[c] = "failed" THEN {"failed", "exhausted"}  \* 987-1000
               ELSE {result[c]}) :
       node' = n                                          \* 1001-1014
  /\ holder' = c                                          \* 1011
  /\ cmd' = [cmd EXCEPT ![c] = result[c]]                 \* 1015-1028
  /\ \E last \in (IF result[c] = "complete" THEN BOOLEAN ELSE {FALSE}) :
       \* 1029-1040: `last` says every other step of the run is verified
       runStatus' = IF last THEN "complete" ELSE "active"
  /\ runRev' = runRev + 1
  /\ lease' = "free"                                      \* 1115
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ lateCommit' = (lateCommit \/ c \in superseded)
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << outbox, result, expRev, reval, revalRev, revalLeft, calls,
                  blind, rejected >>

\* The commit transaction throws PersistenceConflict (968, 978-982).
CommitRefused(c) ==
  /\ worker[c] = "ran"
  /\ ~CanCommit(c)
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, result,
                  expRev, reval, revalRev, revalLeft, calls, blind, rejected,
                  superseded, lateCommit >>

(***************************************************************************)
(* execute() called again with a commandId that has a record (708-809).    *)
(* The only thing such a call can change is the takeover (711-797): the    *)
(* record is `running`, the run is active and the lease can be claimed.    *)
(* Every other replay returns the stored state and changes nothing, so it  *)
(* is not an action here.                                                  *)
(***************************************************************************)
Takeover(c) ==
  /\ cmd[c] = "running"                           \* 711
  /\ runStatus = "active" \/ ReconcileInAnyRun    \* 711
  /\ lease = "free"                               \* 713-722: tx.claim
  /\ IF TakeoverRerunsHandler
     THEN /\ worker[c] = "gone"
          /\ worker' = [worker EXCEPT ![c] = "admitted"]
          /\ lease' = c
          /\ UNCHANGED << runRev, node, holder, cmd, outbox, superseded >>
     ELSE /\ cmd' = [cmd EXCEPT ![c] = "uncertain"]   \* 732-741
          \* 728-731: a step recorded complete and verified is not written
          /\ IF node = "complete" /\ ~TakeoverIgnoresStep
             THEN UNCHANGED << node, holder >>
             ELSE /\ node' = "uncertain"              \* 742-752
                  /\ holder' = c
          /\ runRev' = runRev + 1                     \* 753-757
          /\ outbox' = outbox \cup {c}                \* 776-785
          /\ lease' = "free"                          \* 786
          /\ superseded' = superseded \cup InFlight
          /\ UNCHANGED worker
  /\ UNCHANGED << runStatus, result, expRev, reval, revalRev, revalLeft,
                  calls, blind, rejected, lateCommit >>

\* The database clock passes the claim's `expires` (60 s, 862 and 476).
LeaseExpires ==
  /\ lease # "free"
  /\ lease' = "free"
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, worker,
                  result, expRev, reval, revalRev, revalLeft, calls, blind,
                  rejected, superseded, lateCommit >>

\* cancel() (439-453). It does not look at the run's status.
CancelRun ==
  /\ runStatus # "cancelled"
  /\ runStatus' = "cancelled"       \* 448-452
  /\ runRev' = runRev + 1
  /\ lease' = "free"                \* 447: tx.cancel
  /\ superseded' = superseded \cup InFlight
  /\ UNCHANGED << node, holder, cmd, outbox, worker, result, expRev, reval,
                  revalRev, revalLeft, calls, blind, rejected, lateCommit >>

\* revalidate(), first transaction (459-479): read the run and claim it.
RevalidateStart ==
  /\ reval = "idle"
  /\ revalLeft > 0
  /\ runStatus # "cancelled"        \* 461-462
  /\ lease = "free"                 \* 473-477: tx.claim
  /\ lease' = "revalidation"
  /\ reval' = "checking"
  /\ revalRev' = runRev
  /\ revalLeft' = revalLeft - 1
  /\ superseded' = superseded \cup InFlight
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, worker,
                  result, expRev, calls, blind, rejected, lateCommit >>

(***************************************************************************)
(* revalidate(), the provider checks (480-521) and the last transaction    *)
(* (522-563). `reject` is what the provider no longer vouches for:         *)
(* "nothing"; "step", this step's own evidence (only a verified step is    *)
(* asked, 487); or "dependency", a step this one depends on (483-486).     *)
(* A rejected step with a recorded state is rewritten as plain "failed"    *)
(* whatever it was, and keeps the command named on it (542-554).           *)
(***************************************************************************)
RevalidateFinish(reject) ==
  /\ reval = "checking"
  /\ lease = "revalidation"                           \* 524
  /\ runRev = revalRev /\ runStatus # "cancelled"     \* 525-529
  /\ reject = "step" => node = "complete"             \* 487
  /\ reval' = "idle"
  /\ lease' = "free"                                  \* 562
  /\ IF reject = "nothing"
     THEN UNCHANGED << runStatus, runRev, node, rejected >>
     ELSE /\ node' = IF node = "pending" THEN "pending"            \* 542-544
                     ELSE IF node = "uncertain" /\ RevalidateKeepsUncertain
                          THEN "uncertain"
                          ELSE "failed"                            \* 545-554
          /\ runStatus' = "active"                                 \* 556-561
          /\ runRev' = runRev + 1
          /\ rejected' = rejected \cup {c \in Commands : cmd[c] = "complete"}
  /\ UNCHANGED << holder, cmd, outbox, worker, result, expRev, revalRev,
                  revalLeft, calls, blind, superseded, lateCommit >>

\* The revalidate() call dies, is denied (493-494, 532-539) or is refused
\* (524-529). Nothing is written and its lease is not released.
RevalidationAbandoned ==
  /\ reval = "checking"
  /\ reval' = "idle"
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, worker,
                  result, expRev, revalRev, revalLeft, calls, blind, rejected,
                  superseded, lateCommit >>

(***************************************************************************)
(* The declared ends: every command record is in a state that execute()    *)
(* never changes again, and no call is in flight. Anything else with no    *)
(* step out is a dead end, which TLC reports as a deadlock.                *)
(***************************************************************************)
Settled ==
  /\ \A c \in Commands : cmd[c] # "running" /\ worker[c] \notin {"admitted", "ran"}
  /\ reval = "idle"

Done == Settled /\ UNCHANGED vars

Next ==
  \/ \E c \in Commands : Admit(c)
  \/ \E c \in Commands, r \in Results : CallHandler(c, r)
  \/ \E c \in Commands : HandlerNotCalled(c)
  \/ \E c \in Commands : WorkerLost(c)
  \/ \E c \in Commands : Commit(c)
  \/ \E c \in Commands : CommitRefused(c)
  \/ \E c \in Commands : Takeover(c)
  \/ LeaseExpires
  \/ CancelRun
  \/ RevalidateStart
  \/ \E reject \in {"nothing", "step", "dependency"} : RevalidateFinish(reject)
  \/ RevalidationAbandoned
  \/ Done

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* The rules.                                                              *)
(***************************************************************************)

\* The handler is called at most once for one commandId.
OneCallPerCommand == \A c \in Commands : calls[c] <= 1

\* A handler call always has its command and effect records in the store.
EveryCallHasIntent == \A c \in Commands : calls[c] > 0 => cmd[c] # "none"

\* A worker whose lease someone else has taken never records its result.
SupersededWorkerNeverCommits == ~lateCommit

\* The handler is never called for the step while the step is recorded
\* complete, or while another command's call has an unknown outcome.
NeverBlindRepeat == ~blind

\* A command recorded `complete` has its step recorded complete and
\* verified, unless a revalidation rejected the step afterwards.
CompleteStaysVerified ==
  \A c \in Commands : (cmd[c] = "complete" /\ c \notin rejected) => node = "complete"

\* While a command is recorded `uncertain`, its step is recorded
\* `uncertain`, which is what keeps every new command out (827).
UncertainStaysBlocked ==
  \A c \in Commands : cmd[c] = "uncertain" => node = "uncertain"

(***************************************************************************)
(* Used only by Lifecycle.cfg, to keep the drawn chart small. Revisions    *)
(* are only ever compared for equality, so the view keeps the comparisons  *)
(* and drops the numbers; it also drops the history that no step reads.    *)
(***************************************************************************)
ChartView ==
  << runStatus, node, cmd, outbox, lease, worker, result, reval, revalLeft,
     calls, rejected,
     [c \in Commands |-> worker[c] \in {"admitted", "ran"} /\ runRev = expRev[c]],
     reval = "checking" /\ runRev = revalRev >>

=============================================================================
