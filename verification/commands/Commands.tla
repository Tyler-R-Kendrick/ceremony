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
  TakeoverRerunsHandler, \* the takeover branch (798-872) admits a new worker
                         \* for the command instead of recording `uncertain`
  HandlerBeforeIntent,   \* the command and effect records (947-961) are not
                         \* written before the handler call (998)
  SkipAssertFence,       \* the commit drops `await tx.assertFence(fence)` (1043)
  AdmitIgnoresHolder,    \* admission does not read the command named on the
                         \* step (908-917)
  TakeoverIgnoresStep,   \* the takeover writes the step `uncertain` without
                         \* reading it first (803-806, 817-827)
  CancelLeavesRunning,   \* cancel does not settle the command in flight
                         \* (456-457 removed)

  \* Sketches of guards the findings point at. FALSE is the code as written.
  \* They are not product code and nobody has reviewed them as a design.
  ReconcileInAnyRun,        \* the takeover branch drops `run.status ===
                            \* "active"` from its condition (786)
  RevalidateKeepsUncertain  \* revalidate leaves an `uncertain` step alone (620-629)

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
  reopened,   \* a revalidation rewrote an `uncertain` step as "failed"
  superseded, \* workers whose lease another party has taken since
  lateCommit  \* a superseded worker recorded its result

vars == << runStatus, runRev, node, holder, cmd, outbox, lease, worker, result,
           expRev, reval, revalRev, revalLeft, calls, blind, rejected,
           reopened, superseded, lateCommit >>

(***************************************************************************)
(* The step's NodeRecord, as one word:                                     *)
(*   "pending"   no record, or a record with no `state`: admission       *)
(*               names the command on a step with no record (950-956)  *)
(*   "complete"  {state: "complete", verified: true}                       *)
(*   "waiting"   {state: "awaiting-human" or "verifying", verified: false} *)
(*   "failed"    {state: "failed", verified: false}, may be attempted      *)
(*   "exhausted" {state: "failed", verified: false, exhausted: true}       *)
(*   "uncertain" {state: "uncertain", verified: false}                     *)
(* The service writes `verified: true` only with state "complete", and     *)
(* turns a complete result that fails verification into "failed"           *)
(* (1000-1011, 1028-1035), so no other combination is ever stored.             *)
(***************************************************************************)
NodeStates == {"pending", "complete", "waiting", "failed", "exhausted", "uncertain"}

\* OperationResult.state after verification and success criteria (998-1037).
Results == {"complete", "waiting", "failed", "uncertain"}

CmdStates == {"none", "running"} \cup Results

InFlight == {c \in Commands : worker[c] \in {"admitted", "ran"}}

\* The command named on the step is still `running` (908-917).
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
  /\ reopened \in BOOLEAN
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
  /\ reopened = FALSE
  /\ superseded = {}
  /\ lateCommit = FALSE

(***************************************************************************)
(* execute(), admission transaction (758-972), no record for this          *)
(* commandId yet (885-971). It refuses while the command named on the step *)
(* is `running` (908-917), claims the run's lease, writes the command and  *)
(* effect records, and names the command on the step's node record         *)
(* (947-961). It does NOT write the run record, and the step's `state` is  *)
(* kept, so the run revision and the step's state stay as they were.       *)
(***************************************************************************)
Admit(c) ==
  /\ cmd[c] = "none"                           \* 780-783: no prior record
  /\ worker[c] \notin {"admitted", "ran"}      \* only bites with HandlerBeforeIntent
  /\ runStatus = "active"                      \* 885-889, and the caller sends
                                               \* the revision it last read
  /\ node \in {"pending", "waiting", "failed"} \* 898-907
  /\ AdmitIgnoresHolder \/ ~HolderRunning      \* 908-917
  /\ lease = "free"                            \* 934-938: tx.claim
  /\ lease' = c
  /\ holder' = c                               \* 950-956
  /\ cmd' = IF HandlerBeforeIntent THEN cmd    \* 947-961: command "running",
            ELSE [cmd EXCEPT ![c] = "running"] \* effect "intent-persisted"
  /\ worker' = [worker EXCEPT ![c] = "admitted"]
  /\ expRev' = [expRev EXCEPT ![c] = runRev]
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << runStatus, runRev, node, outbox, result, reval, revalRev,
                  revalLeft, calls, blind, rejected, reopened, lateCommit >>

(***************************************************************************)
(* Between the transactions (994-1037): the handler, its verification and   *)
(* the success criteria. The store is not touched. A handler call is a     *)
(* blind repeat when the step is recorded complete, or when another        *)
(* command's call for the step has an unknown outcome: its command is      *)
(* still `running`, or `uncertain`.                                        *)
(***************************************************************************)
CallHandler(c, r) ==
  /\ worker[c] = "admitted"
  /\ calls' = [calls EXCEPT ![c] = IF @ < 2 THEN @ + 1 ELSE @]  \* 998
  /\ blind' = \/ blind
              \/ node = "complete"
              \/ \E d \in Commands \ {c} :
                   calls[d] > 0 /\ cmd[d] \in {"running", "uncertain"}
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = r]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, expRev,
                  reval, revalRev, revalLeft, rejected, reopened, superseded,
                  lateCommit >>

\* Authorization is withdrawn or the call is aborted just before the handler
\* (995-997): the catch (1012-1015) makes the result `uncertain`, no call made.
HandlerNotCalled(c) ==
  /\ worker[c] = "admitted"
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = "uncertain"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, expRev,
                  reval, revalRev, revalLeft, calls, blind, rejected, reopened,
                  superseded, lateCommit >>

\* The process dies, or authorization is withdrawn after the handler
\* (1038-1039, 1045-1052). Nothing is written and the lease is not released.
WorkerLost(c) ==
  /\ worker[c] \in {"admitted", "ran"}
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, result,
                  expRev, reval, revalRev, revalLeft, calls, blind, rejected, reopened,
                  superseded, lateCommit >>

CanCommit(c) ==
  /\ SkipAssertFence \/ lease = c                 \* 1043: tx.assertFence
  /\ runStatus = "active" /\ runRev = expRev[c]   \* 1053-1057

(***************************************************************************)
(* execute(), commit transaction (1040-1199): node, command, effect and run *)
(* records are written together, then the lease is released (1190).        *)
(***************************************************************************)
Commit(c) ==
  /\ worker[c] = "ran"
  /\ CanCommit(c)
  /\ \E n \in (IF result[c] = "failed" THEN {"failed", "exhausted"}  \* 1062-1075
               ELSE {result[c]}) :
       node' = n                                          \* 1076-1089
  /\ holder' = c                                          \* 1086
  /\ cmd' = [cmd EXCEPT ![c] = result[c]]                 \* 1090-1103
  /\ \E last \in (IF result[c] = "complete" THEN BOOLEAN ELSE {FALSE}) :
       \* 1104-1115: `last` says every other step of the run is verified
       runStatus' = IF last THEN "complete" ELSE "active"
  /\ runRev' = runRev + 1
  /\ lease' = "free"                                      \* 1190
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ lateCommit' = (lateCommit \/ c \in superseded)
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << outbox, result, expRev, reval, revalRev, revalLeft, calls,
                  blind, rejected, reopened >>

\* The commit transaction throws PersistenceConflict (1043, 1053-1057).
CommitRefused(c) ==
  /\ worker[c] = "ran"
  /\ ~CanCommit(c)
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, result,
                  expRev, reval, revalRev, revalLeft, calls, blind, rejected, reopened,
                  superseded, lateCommit >>

(***************************************************************************)
(* execute() called again with a commandId that has a record (783-884).    *)
(* The only thing such a call can change is the takeover (786-872): the    *)
(* record is `running`, the run is active and the lease can be claimed.    *)
(* Every other replay returns the stored state and changes nothing, so it  *)
(* is not an action here.                                                  *)
(***************************************************************************)
Takeover(c) ==
  /\ cmd[c] = "running"                           \* 786
  /\ runStatus = "active" \/ ReconcileInAnyRun    \* 786
  /\ lease = "free"                               \* 788-797: tx.claim
  /\ IF TakeoverRerunsHandler
     THEN /\ worker[c] = "gone"
          /\ worker' = [worker EXCEPT ![c] = "admitted"]
          /\ lease' = c
          /\ UNCHANGED << runRev, node, holder, cmd, outbox, superseded >>
     ELSE /\ cmd' = [cmd EXCEPT ![c] = "uncertain"]   \* 807-816
          \* 803-806: a step recorded complete and verified is not written
          /\ IF node = "complete" /\ ~TakeoverIgnoresStep
             THEN UNCHANGED << node, holder >>
             ELSE /\ node' = "uncertain"              \* 817-827
                  /\ holder' = c
          /\ runRev' = runRev + 1                     \* 828-832
          /\ outbox' = outbox \cup {c}                \* 851-860
          /\ lease' = "free"                          \* 861
          /\ superseded' = superseded \cup InFlight
          /\ UNCHANGED worker
  /\ UNCHANGED << runStatus, result, expRev, reval, revalRev, revalLeft,
                  calls, blind, rejected, reopened, lateCommit >>

\* The database clock passes the claim's `expires` (60 s, 937 and 551).
LeaseExpires ==
  /\ lease # "free"
  /\ lease' = "free"
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, worker,
                  result, expRev, reval, revalRev, revalLeft, calls, blind,
                  rejected, reopened, superseded, lateCommit >>

(***************************************************************************)
(* cancel() (439-460). It does not look at the run's status. In the same   *)
(* transaction (456-457), settleInFlight (461-530) reads the command named *)
(* on the step (471-477). If it is `running`, the command and its effect   *)
(* become `uncertain` (481-490); unless the step is recorded verified      *)
(* (491), it becomes `uncertain` naming the command (492-501); and an      *)
(* outbox entry `reconciliation:<commandId>` is stored (520-529).          *)
(***************************************************************************)
CancelRun ==
  /\ runStatus # "cancelled"
  /\ runStatus' = "cancelled"       \* 448-452
  /\ runRev' = runRev + 1
  /\ lease' = "free"                \* 447: tx.cancel
  /\ superseded' = superseded \cup InFlight
  /\ IF HolderRunning /\ ~CancelLeavesRunning               \* 471-477
     THEN /\ cmd' = [cmd EXCEPT ![holder] = "uncertain"]    \* 481-490
          /\ node' = IF node = "complete" THEN node         \* 491
                     ELSE "uncertain"                       \* 492-501
          /\ outbox' = outbox \cup {holder}                 \* 520-529
     ELSE UNCHANGED << node, cmd, outbox >>
  /\ UNCHANGED << holder, worker, result, expRev, reval, revalRev, revalLeft,
                  calls, blind, rejected, reopened, lateCommit >>

\* revalidate(), first transaction (534-554): read the run and claim it.
RevalidateStart ==
  /\ reval = "idle"
  /\ revalLeft > 0
  /\ runStatus # "cancelled"        \* 536-537
  /\ lease = "free"                 \* 548-552: tx.claim
  /\ lease' = "revalidation"
  /\ reval' = "checking"
  /\ revalRev' = runRev
  /\ revalLeft' = revalLeft - 1
  /\ superseded' = superseded \cup InFlight
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, worker,
                  result, expRev, calls, blind, rejected, reopened, lateCommit >>

(***************************************************************************)
(* revalidate(), the provider checks (555-596) and the last transaction    *)
(* (597-638). `reject` is what the provider no longer vouches for:         *)
(* "nothing"; "step", this step's own evidence (only a verified step is    *)
(* asked, 562); or "dependency", a step this one depends on (558-561).     *)
(* A rejected step with a recorded state is rewritten as plain "failed"    *)
(* whatever it was, and keeps the command named on it (617-629).           *)
(***************************************************************************)
RevalidateFinish(reject) ==
  /\ reval = "checking"
  /\ lease = "revalidation"                           \* 599
  /\ runRev = revalRev /\ runStatus # "cancelled"     \* 600-604
  /\ reject = "step" => node = "complete"             \* 562
  /\ reval' = "idle"
  /\ lease' = "free"                                  \* 637
  /\ IF reject = "nothing"
     THEN UNCHANGED << runStatus, runRev, node, rejected, reopened >>
     ELSE /\ node' = IF node = "pending" THEN "pending"            \* 617-619
                     ELSE IF node = "uncertain" /\ RevalidateKeepsUncertain
                          THEN "uncertain"
                          ELSE "failed"                            \* 620-629
          /\ runStatus' = "active"                                 \* 631-636
          /\ runRev' = runRev + 1
          /\ rejected' = rejected \cup {c \in Commands : cmd[c] = "complete"}
          /\ reopened' = (reopened \/ (node = "uncertain" /\ node' = "failed"))
  /\ UNCHANGED << holder, cmd, outbox, worker, result, expRev, revalRev,
                  revalLeft, calls, blind, superseded, lateCommit >>

\* The revalidate() call dies, is denied (568-569, 607-614) or is refused
\* (599-604). Nothing is written and its lease is not released.
RevalidationAbandoned ==
  /\ reval = "checking"
  /\ reval' = "idle"
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, worker,
                  result, expRev, revalRev, revalLeft, calls, blind, rejected, reopened,
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

\* One call per step: NeverBlindRepeat holds on every path on which no
\* revalidation has rewritten an `uncertain` step as "failed". That rewrite
\* is finding 4; this rule leaves it to NeverBlindRepeat and
\* UncertainStaysBlocked.
OneCallPerStep == reopened \/ ~blind

\* A command recorded `complete` has its step recorded complete and
\* verified, unless a revalidation rejected the step afterwards.
CompleteStaysVerified ==
  \A c \in Commands : (cmd[c] = "complete" /\ c \notin rejected) => node = "complete"

\* While a command is recorded `uncertain`, its step is recorded
\* `uncertain`, which is what keeps every new command out (902).
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
