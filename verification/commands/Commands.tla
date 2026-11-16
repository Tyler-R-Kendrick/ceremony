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
  TakeoverRerunsHandler, \* the takeover branch (706-770) admits a new worker
                         \* for the command instead of recording `uncertain`
  HandlerBeforeIntent,   \* the command and effect records (835-840) are not
                         \* written before the handler call (877)
  SkipAssertFence,       \* the commit drops `await tx.assertFence(fence)` (922)

  \* Sketches of guards the findings point at. FALSE is the code as written.
  \* They are not product code and nobody has reviewed them as a design.
  RefuseOverUnresolved,     \* admission refuses a new command while another
                            \* command for the step is still `running`
  ReconcileInAnyRun,        \* the takeover branch drops `run.status ===
                            \* "active"` from its condition (694)
  RevalidateKeepsUncertain  \* revalidate leaves an `uncertain` step alone (532-537)

VARIABLES
  \* What the store holds.
  runStatus,  \* RunRecord.status
  runRev,     \* the revision of the run record
  node,       \* the step's NodeRecord, see NodeStates
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

vars == << runStatus, runRev, node, cmd, outbox, lease, worker, result, expRev,
           reval, revalRev, revalLeft, calls, blind, rejected, superseded,
           lateCommit >>

(***************************************************************************)
(* The step's NodeRecord, as one word:                                     *)
(*   "pending"   no record                                                 *)
(*   "complete"  {state: "complete", verified: true}                       *)
(*   "waiting"   {state: "awaiting-human" or "verifying", verified: false} *)
(*   "failed"    {state: "failed", verified: false}, may be attempted      *)
(*   "exhausted" {state: "failed", verified: false, exhausted: true}       *)
(*   "uncertain" {state: "uncertain", verified: false}                     *)
(* The service writes `verified: true` only with state "complete", and     *)
(* turns a complete result that fails verification into "failed"           *)
(* (879-890, 907-914), so no other combination is ever stored.             *)
(***************************************************************************)
NodeStates == {"pending", "complete", "waiting", "failed", "exhausted", "uncertain"}

\* OperationResult.state after verification and success criteria (877-916).
Results == {"complete", "waiting", "failed", "uncertain"}

CmdStates == {"none", "running"} \cup Results

InFlight == {c \in Commands : worker[c] \in {"admitted", "ran"}}

TypeOK ==
  /\ runStatus \in {"active", "cancelled", "complete"}
  /\ runRev \in Nat
  /\ node \in NodeStates
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

\* createRun (353-355) stores the run at revision 1; nothing else exists.
Init ==
  /\ runStatus = "active"
  /\ runRev = 1
  /\ node = "pending"
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
(* execute(), admission transaction (666-851), no record for this          *)
(* commandId yet (783-850). It writes the command and effect records and   *)
(* claims the run's lease. It does NOT write the node record or the run    *)
(* record, so the run revision and the step's state stay as they were.     *)
(***************************************************************************)
Admit(c) ==
  /\ cmd[c] = "none"                           \* 688-691: no prior record
  /\ worker[c] \notin {"admitted", "ran"}      \* only bites with HandlerBeforeIntent
  /\ runStatus = "active"                      \* 783-787, and the caller sends
                                               \* the revision it last read
  /\ node \in {"pending", "waiting", "failed"} \* 796-805
  /\ lease = "free"                            \* 822-826: tx.claim
  /\ RefuseOverUnresolved =>
       \A d \in Commands \ {c} : cmd[d] # "running"
  /\ lease' = c
  /\ cmd' = IF HandlerBeforeIntent THEN cmd    \* 835-840: command "running",
            ELSE [cmd EXCEPT ![c] = "running"] \* effect "intent-persisted"
  /\ worker' = [worker EXCEPT ![c] = "admitted"]
  /\ expRev' = [expRev EXCEPT ![c] = runRev]
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << runStatus, runRev, node, outbox, result, reval, revalRev,
                  revalLeft, calls, blind, rejected, lateCommit >>

(***************************************************************************)
(* Between the transactions (873-916): the handler, its verification and   *)
(* the success criteria. The store is not touched. A handler call is a     *)
(* blind repeat when the step is recorded complete, or when another        *)
(* command's call for the step has an unknown outcome: its command is      *)
(* still `running`, or `uncertain`.                                        *)
(***************************************************************************)
CallHandler(c, r) ==
  /\ worker[c] = "admitted"
  /\ calls' = [calls EXCEPT ![c] = IF @ < 2 THEN @ + 1 ELSE @]  \* 877
  /\ blind' = \/ blind
              \/ node = "complete"
              \/ \E d \in Commands \ {c} :
                   calls[d] > 0 /\ cmd[d] \in {"running", "uncertain"}
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = r]
  /\ UNCHANGED << runStatus, runRev, node, cmd, outbox, lease, expRev, reval,
                  revalRev, revalLeft, rejected, superseded, lateCommit >>

\* Authorization is withdrawn or the call is aborted just before the handler
\* (874-876): the catch (891-894) makes the result `uncertain`, no call made.
HandlerNotCalled(c) ==
  /\ worker[c] = "admitted"
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = "uncertain"]
  /\ UNCHANGED << runStatus, runRev, node, cmd, outbox, lease, expRev, reval,
                  revalRev, revalLeft, calls, blind, rejected, superseded,
                  lateCommit >>

\* The process dies, or authorization is withdrawn after the handler
\* (917-918, 924-931). Nothing is written and the lease is not released.
WorkerLost(c) ==
  /\ worker[c] \in {"admitted", "ran"}
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, cmd, outbox, lease, result, expRev,
                  reval, revalRev, revalLeft, calls, blind, rejected,
                  superseded, lateCommit >>

CanCommit(c) ==
  /\ SkipAssertFence \/ lease = c                 \* 922: tx.assertFence
  /\ runStatus = "active" /\ runRev = expRev[c]   \* 932-936

(***************************************************************************)
(* execute(), commit transaction (919-1077): node, command, effect and run *)
(* records are written together, then the lease is released (1068).        *)
(***************************************************************************)
Commit(c) ==
  /\ worker[c] = "ran"
  /\ CanCommit(c)
  /\ \E n \in (IF result[c] = "failed" THEN {"failed", "exhausted"}  \* 941-954
               ELSE {result[c]}) :
       node' = n                                          \* 955-967
  /\ cmd' = [cmd EXCEPT ![c] = result[c]]                 \* 968-981
  /\ \E last \in (IF result[c] = "complete" THEN BOOLEAN ELSE {FALSE}) :
       \* 982-993: `last` says every other step of the run is verified
       runStatus' = IF last THEN "complete" ELSE "active"
  /\ runRev' = runRev + 1
  /\ lease' = "free"                                      \* 1068
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ lateCommit' = (lateCommit \/ c \in superseded)
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << outbox, result, expRev, reval, revalRev, revalLeft, calls,
                  blind, rejected >>

\* The commit transaction throws PersistenceConflict (922, 932-936).
CommitRefused(c) ==
  /\ worker[c] = "ran"
  /\ ~CanCommit(c)
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, cmd, outbox, lease, result, expRev,
                  reval, revalRev, revalLeft, calls, blind, rejected,
                  superseded, lateCommit >>

(***************************************************************************)
(* execute() called again with a commandId that has a record (691-782).    *)
(* The only thing such a call can change is the takeover (694-770): the    *)
(* record is `running`, the run is active and the lease can be claimed.    *)
(* Every other replay returns the stored state and changes nothing, so it  *)
(* is not an action here.                                                  *)
(***************************************************************************)
Takeover(c) ==
  /\ cmd[c] = "running"                           \* 694
  /\ runStatus = "active" \/ ReconcileInAnyRun    \* 694
  /\ lease = "free"                               \* 696-705: tx.claim
  /\ IF TakeoverRerunsHandler
     THEN /\ worker[c] = "gone"
          /\ worker' = [worker EXCEPT ![c] = "admitted"]
          /\ lease' = c
          /\ UNCHANGED << runRev, node, cmd, outbox, superseded >>
     ELSE /\ cmd' = [cmd EXCEPT ![c] = "uncertain"]   \* 712-721
          /\ node' = "uncertain"                      \* 722-726
          /\ runRev' = runRev + 1                     \* 727-731
          /\ outbox' = outbox \cup {c}                \* 749-758
          /\ lease' = "free"                          \* 759
          /\ superseded' = superseded \cup InFlight
          /\ UNCHANGED worker
  /\ UNCHANGED << runStatus, result, expRev, reval, revalRev, revalLeft,
                  calls, blind, rejected, lateCommit >>

\* The database clock passes the claim's `expires` (60 s, 825 and 465).
LeaseExpires ==
  /\ lease # "free"
  /\ lease' = "free"
  /\ UNCHANGED << runStatus, runRev, node, cmd, outbox, worker, result,
                  expRev, reval, revalRev, revalLeft, calls, blind, rejected,
                  superseded, lateCommit >>

\* cancel() (428-442). It does not look at the run's status.
CancelRun ==
  /\ runStatus # "cancelled"
  /\ runStatus' = "cancelled"       \* 437-441
  /\ runRev' = runRev + 1
  /\ lease' = "free"                \* 436: tx.cancel
  /\ superseded' = superseded \cup InFlight
  /\ UNCHANGED << node, cmd, outbox, worker, result, expRev, reval, revalRev,
                  revalLeft, calls, blind, rejected, lateCommit >>

\* revalidate(), first transaction (448-468): read the run and claim it.
RevalidateStart ==
  /\ reval = "idle"
  /\ revalLeft > 0
  /\ runStatus # "cancelled"        \* 450-451
  /\ lease = "free"                 \* 462-466: tx.claim
  /\ lease' = "revalidation"
  /\ reval' = "checking"
  /\ revalRev' = runRev
  /\ revalLeft' = revalLeft - 1
  /\ superseded' = superseded \cup InFlight
  /\ UNCHANGED << runStatus, runRev, node, cmd, outbox, worker, result,
                  expRev, calls, blind, rejected, lateCommit >>

(***************************************************************************)
(* revalidate(), the provider checks (469-510) and the last transaction    *)
(* (511-546). `reject` is what the provider no longer vouches for:         *)
(* "nothing"; "step", this step's own evidence (only a verified step is    *)
(* asked, 476); or "dependency", a step this one depends on (472-475).     *)
(* A rejected step with a record is rewritten as plain "failed" whatever   *)
(* it was (529-537).                                                       *)
(***************************************************************************)
RevalidateFinish(reject) ==
  /\ reval = "checking"
  /\ lease = "revalidation"                           \* 513
  /\ runRev = revalRev /\ runStatus # "cancelled"     \* 514-518
  /\ reject = "step" => node = "complete"             \* 476
  /\ reval' = "idle"
  /\ lease' = "free"                                  \* 545
  /\ IF reject = "nothing"
     THEN UNCHANGED << runStatus, runRev, node, rejected >>
     ELSE /\ node' = IF node = "pending" THEN "pending"            \* 531-532
                     ELSE IF node = "uncertain" /\ RevalidateKeepsUncertain
                          THEN "uncertain"
                          ELSE "failed"                            \* 533-537
          /\ runStatus' = "active"                                 \* 539-544
          /\ runRev' = runRev + 1
          /\ rejected' = rejected \cup {c \in Commands : cmd[c] = "complete"}
  /\ UNCHANGED << cmd, outbox, worker, result, expRev, revalRev, revalLeft,
                  calls, blind, superseded, lateCommit >>

\* The revalidate() call dies, is denied (482-483, 521-528) or is refused
\* (513-518). Nothing is written and its lease is not released.
RevalidationAbandoned ==
  /\ reval = "checking"
  /\ reval' = "idle"
  /\ UNCHANGED << runStatus, runRev, node, cmd, outbox, lease, worker, result,
                  expRev, revalRev, revalLeft, calls, blind, rejected,
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
\* `uncertain`, which is what keeps every new command out (800).
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
