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
  Replay,            \* effectiveReplay of the step's operation
                     \* (src/server/recipes/registry.ts): "read-only",
                     \* "upstream-idempotency-key" or "reconciliation".
                     \* An operation with no declared replay is run as
                     \* "reconciliation".

  \* Broken variants. FALSE is the code as written.
  TakeoverRerunsHandler, \* the takeover branch (823-898) admits a new worker
                         \* for the command instead of recording `uncertain`
  HandlerBeforeIntent,   \* the command and effect records (977-1004) are not
                         \* written before the handler call (1041)
  SkipAssertFence,       \* the commit drops `await tx.assertFence(fence)` (1086)
  AdmitIgnoresHolder,    \* admission does not read the command named on the
                         \* step (938-947)
  TakeoverIgnoresStep,   \* the takeover writes the step `uncertain` without
                         \* reading it first (828-831, 842-853)
  CancelLeavesRunning,   \* cancel does not settle the command in flight
                         \* (469-470 removed)
  RevalidateReopens,     \* revalidate rewrites an `uncertain` or exhausted
                         \* step as plain "failed" (637 and 650 removed)
  CommitSkipsReconciliation, \* the commit stores no reconciliation entry for
                             \* an `uncertain` result (1155-1158 removed)
  ResolveWithoutVerified, \* the commit resolves the step's earlier
                          \* reconciliation entries whatever its result
                          \* (`if (verified)` at 1138 removed)
  ReadOnlyStaysBlocked,  \* admission refuses an `uncertain` step whatever
                         \* its operation's replay (932: the replay test removed)

  \* Sketch of a guard a finding pointed at. FALSE is the code as written.
  \* It is not product code and nobody has reviewed it as a design.
  ReconcileInAnyRun         \* the takeover branch drops `run.status ===
                            \* "active"` from its condition (811)

VARIABLES
  \* What the store holds.
  runStatus,  \* RunRecord.status
  runRev,     \* the revision of the run record
  node,       \* the step's NodeRecord, see NodeStates
  holder,     \* NodeRecord.command: the command admitted last for the step,
              \* "none" = no record or no such field
  cmd,        \* cmd[c]: CommandRecord.state of command c, "none" = no record
  outbox,     \* commands with an outbox entry `reconciliation:<commandId>`
  resolved,   \* commands whose entry is marked "resolved" (1282-1293);
              \* every other entry in `outbox` is "pending"
  reconciling, \* NodeRecord.reconciling: commands recorded `uncertain` on
               \* a read-only step before the command named on it
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
           reopened, superseded, lateCommit, resolved, reconciling >>

recVars == << resolved, reconciling >>

(***************************************************************************)
(* The step's NodeRecord, as one word:                                     *)
(*   "pending"   no record, or a record with no `state`: admission       *)
(*               names the command on a step with no record (982-999)  *)
(*   "complete"  {state: "complete", verified: true}                       *)
(*   "waiting"   {state: "awaiting-human" or "verifying", verified: false} *)
(*   "failed"    {state: "failed", verified: false}, may be attempted      *)
(*   "exhausted" {state: "failed", verified: false, exhausted: true}       *)
(*   "uncertain" {state: "uncertain", verified: false}                     *)
(* The service writes `verified: true` only with state "complete", and     *)
(* turns a complete result that fails verification into "failed"           *)
(* (1043-1054, 1071-1078), so no other combination is ever stored.             *)
(***************************************************************************)
NodeStates == {"pending", "complete", "waiting", "failed", "exhausted", "uncertain"}

\* OperationResult.state after verification and success criteria (1041-1080).
Results == {"complete", "waiting", "failed", "uncertain"}

CmdStates == {"none", "running"} \cup Results

\* The step states admission accepts a new command id from (924-937).
\* An `uncertain` step is accepted only for an operation registered with
\* replay "read-only" (930-932).
AdmitFrom ==
  {"pending", "waiting", "failed"}
    \cup (IF Replay = "read-only" /\ ~ReadOnlyStaysBlocked
          THEN {"uncertain"} ELSE {})

InFlight == {c \in Commands : worker[c] \in {"admitted", "ran"}}

\* The command named on the step is still `running` (938-947).
HolderRunning == holder # "none" /\ cmd[holder] = "running"

TypeOK ==
  /\ Replay \in {"read-only", "upstream-idempotency-key", "reconciliation"}
  /\ runStatus \in {"active", "cancelled", "complete"}
  /\ runRev \in Nat
  /\ node \in NodeStates
  /\ holder \in Commands \cup {"none"}
  /\ cmd \in [Commands -> CmdStates]
  /\ outbox \subseteq Commands
  /\ resolved \subseteq Commands
  /\ reconciling \subseteq Commands
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

\* createRun (376-378) stores the run at revision 1; nothing else exists.
Init ==
  /\ runStatus = "active"
  /\ runRev = 1
  /\ node = "pending"
  /\ holder = "none"
  /\ cmd = [c \in Commands |-> "none"]
  /\ outbox = {}
  /\ resolved = {}
  /\ reconciling = {}
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
(* execute(), admission transaction (783-1015), no record for this          *)
(* commandId yet (911-1014). It refuses while the command named on the step *)
(* is `running` (938-947), claims the run's lease, writes the command and  *)
(* effect records, and names the command on the step's node record         *)
(* (977-1004). It does NOT write the run record, and the step's `state` is  *)
(* kept, so the run revision and the step's state stay as they were.       *)
(***************************************************************************)
Admit(c) ==
  /\ cmd[c] = "none"                           \* 805-808: no prior record
  /\ worker[c] \notin {"admitted", "ran"}      \* only bites with HandlerBeforeIntent
  /\ runStatus = "active"                      \* 911-915, and the caller sends
                                               \* the revision it last read
  /\ node \in AdmitFrom                         \* 924-937
  /\ AdmitIgnoresHolder \/ ~HolderRunning      \* 938-947
  /\ lease = "free"                            \* 964-968: tx.claim
  /\ lease' = c
  /\ holder' = c                               \* 982-999
  \* 980-994: a read-only step run again keeps the command recorded
  \* `uncertain` on it in `reconciling`
  /\ reconciling' = IF node = "uncertain" /\ holder # "none"
                    THEN reconciling \cup {holder} ELSE reconciling
  /\ cmd' = IF HandlerBeforeIntent THEN cmd    \* 977-1004: command "running",
            ELSE [cmd EXCEPT ![c] = "running"] \* effect "intent-persisted"
  /\ worker' = [worker EXCEPT ![c] = "admitted"]
  /\ expRev' = [expRev EXCEPT ![c] = runRev]
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << runStatus, runRev, node, outbox, result, reval, revalRev,
                  revalLeft, calls, blind, rejected, reopened, lateCommit,
                  resolved >>

(***************************************************************************)
(* Between the transactions (1037-1080): the handler, its verification and   *)
(* the success criteria. The store is not touched. A handler call is a     *)
(* blind repeat when the step is recorded complete, or when another        *)
(* command's call for the step has an unknown outcome: its command is      *)
(* still `running`, or `uncertain`. An operation registered with           *)
(* replay "read-only" has no external effect to repeat, so its calls are   *)
(* never blind.                                                            *)
(***************************************************************************)
CallHandler(c, r) ==
  /\ worker[c] = "admitted"
  /\ calls' = [calls EXCEPT ![c] = IF @ < 2 THEN @ + 1 ELSE @]  \* 1041
  /\ blind' = \/ blind
              \/ /\ Replay # "read-only"
                 /\ \/ node = "complete"
                    \/ \E d \in Commands \ {c} :
                         calls[d] > 0 /\ cmd[d] \in {"running", "uncertain"}
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = r]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, expRev,
                  reval, revalRev, revalLeft, rejected, reopened, superseded,
                  lateCommit >>
  /\ UNCHANGED recVars

\* Authorization is withdrawn or the call is aborted just before the handler
\* (1038-1040): the catch (1055-1058) makes the result `uncertain`, no call made.
HandlerNotCalled(c) ==
  /\ worker[c] = "admitted"
  /\ worker' = [worker EXCEPT ![c] = "ran"]
  /\ result' = [result EXCEPT ![c] = "uncertain"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, expRev,
                  reval, revalRev, revalLeft, calls, blind, rejected, reopened,
                  superseded, lateCommit >>
  /\ UNCHANGED recVars

\* The process dies, or authorization is withdrawn after the handler
\* (1081-1082, 1088-1095). Nothing is written and the lease is not released.
WorkerLost(c) ==
  /\ worker[c] \in {"admitted", "ran"}
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, result,
                  expRev, reval, revalRev, revalLeft, calls, blind, rejected, reopened,
                  superseded, lateCommit >>
  /\ UNCHANGED recVars

CanCommit(c) ==
  /\ SkipAssertFence \/ lease = c                 \* 1086: tx.assertFence
  /\ runStatus = "active" /\ runRev = expRev[c]   \* 1096-1100

(***************************************************************************)
(* execute(), commit transaction (1083-1254): node, command, effect and run *)
(* records are written together, with a `reconciliation:<commandId>` outbox *)
(* entry when the result is `uncertain` (1155-1158, queueReconciliation    *)
(* 1262-1280); then the lease is released (1245).                          *)
(***************************************************************************)
Commit(c) ==
  /\ worker[c] = "ran"
  /\ CanCommit(c)
  /\ \E n \in (IF result[c] = "failed" THEN {"failed", "exhausted"}  \* 1105-1118
               ELSE {result[c]}) :
       node' = n                                          \* 1119-1135
  /\ holder' = c                                          \* 1129
  /\ cmd' = [cmd EXCEPT ![c] = result[c]]                 \* 1141-1154
  /\ \E last \in (IF result[c] = "complete" THEN BOOLEAN ELSE {FALSE}) :
       \* 1159-1170: `last` says every other step of the run is verified
       runStatus' = IF last THEN "complete" ELSE "active"
  /\ outbox' = IF result[c] = "uncertain" /\ ~CommitSkipsReconciliation
               THEN outbox \cup {c}                       \* 1155-1158
               ELSE outbox
  \* 1130-1132, 1136-1140: a verified result (only "complete" is verified)
  \* resolves the entries of the commands in `reconciling` and drops it;
  \* any other result keeps it
  /\ IF node' = "complete" \/ ResolveWithoutVerified
     THEN /\ resolved' = resolved \cup (reconciling \cap outbox)
          /\ reconciling' = {}
     ELSE UNCHANGED recVars
  /\ runRev' = runRev + 1
  /\ lease' = "free"                                      \* 1245
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ lateCommit' = (lateCommit \/ c \in superseded)
  /\ superseded' = superseded \cup (InFlight \ {c})
  /\ UNCHANGED << result, expRev, reval, revalRev, revalLeft, calls,
                  blind, rejected, reopened >>

\* The commit transaction throws PersistenceConflict (1086, 1096-1100).
CommitRefused(c) ==
  /\ worker[c] = "ran"
  /\ ~CanCommit(c)
  /\ worker' = [worker EXCEPT ![c] = "gone"]
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, result,
                  expRev, reval, revalRev, revalLeft, calls, blind, rejected, reopened,
                  superseded, lateCommit >>
  /\ UNCHANGED recVars

(***************************************************************************)
(* execute() called again with a commandId that has a record (808-910).    *)
(* The only thing such a call can change is the takeover (811-898): the    *)
(* record is `running`, the run is active and the lease can be claimed.    *)
(* Every other replay returns the stored state and changes nothing, so it  *)
(* is not an action here.                                                  *)
(***************************************************************************)
Takeover(c) ==
  /\ cmd[c] = "running"                           \* 811
  /\ runStatus = "active" \/ ReconcileInAnyRun    \* 811
  /\ lease = "free"                               \* 813-822: tx.claim
  /\ IF TakeoverRerunsHandler
     THEN /\ worker[c] = "gone"
          /\ worker' = [worker EXCEPT ![c] = "admitted"]
          /\ lease' = c
          /\ UNCHANGED << runRev, node, holder, cmd, outbox, superseded >>
     ELSE /\ cmd' = [cmd EXCEPT ![c] = "uncertain"]   \* 832-841
          \* 828-831: a step recorded complete and verified is not written
          /\ IF node = "complete" /\ ~TakeoverIgnoresStep
             THEN UNCHANGED << node, holder >>
             ELSE /\ node' = "uncertain"              \* 842-853
                  /\ holder' = c
          /\ runRev' = runRev + 1                     \* 854-858
          /\ outbox' = outbox \cup {c}                \* 877-886
          /\ lease' = "free"                          \* 887
          /\ superseded' = superseded \cup InFlight
          /\ UNCHANGED worker
  /\ UNCHANGED << runStatus, result, expRev, reval, revalRev, revalLeft,
                  calls, blind, rejected, reopened, lateCommit >>
  /\ UNCHANGED recVars

\* The database clock passes the claim's `expires` (60 s, 967 and 565).
LeaseExpires ==
  /\ lease # "free"
  /\ lease' = "free"
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, worker,
                  result, expRev, reval, revalRev, revalLeft, calls, blind,
                  rejected, reopened, superseded, lateCommit >>
  /\ UNCHANGED recVars

(***************************************************************************)
(* cancel() (452-473). It does not look at the run's status. In the same   *)
(* transaction (469-470), settleInFlight (474-544) reads the command named *)
(* on the step (484-490). If it is `running`, the command and its effect   *)
(* become `uncertain` (494-503); unless the step is recorded verified      *)
(* (504), it becomes `uncertain` naming the command (505-515); and an      *)
(* outbox entry `reconciliation:<commandId>` is stored (534-543).          *)
(***************************************************************************)
CancelRun ==
  /\ runStatus # "cancelled"
  /\ runStatus' = "cancelled"       \* 461-465
  /\ runRev' = runRev + 1
  /\ lease' = "free"                \* 460: tx.cancel
  /\ superseded' = superseded \cup InFlight
  /\ IF HolderRunning /\ ~CancelLeavesRunning               \* 484-490
     THEN /\ cmd' = [cmd EXCEPT ![holder] = "uncertain"]    \* 494-503
          /\ node' = IF node = "complete" THEN node         \* 504
                     ELSE "uncertain"                       \* 505-515
          /\ outbox' = outbox \cup {holder}                 \* 534-543
     ELSE UNCHANGED << node, cmd, outbox >>
  /\ UNCHANGED << holder, worker, result, expRev, reval, revalRev, revalLeft,
                  calls, blind, rejected, reopened, lateCommit >>
  /\ UNCHANGED recVars

\* revalidate(), first transaction (548-568): read the run and claim it.
RevalidateStart ==
  /\ reval = "idle"
  /\ revalLeft > 0
  /\ runStatus # "cancelled"        \* 550-551
  /\ lease = "free"                 \* 562-566: tx.claim
  /\ lease' = "revalidation"
  /\ reval' = "checking"
  /\ revalRev' = runRev
  /\ revalLeft' = revalLeft - 1
  /\ superseded' = superseded \cup InFlight
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, worker,
                  result, expRev, calls, blind, rejected, reopened, lateCommit >>
  /\ UNCHANGED recVars

(***************************************************************************)
(* revalidate(), the provider checks (569-610) and the last transaction    *)
(* (611-663). `reject` is what the provider no longer vouches for:         *)
(* "nothing"; "step", this step's own evidence (only a verified step is    *)
(* asked, 576); or "dependency", a step this one depends on (572-575).     *)
(* A rejected step with no recorded state, or recorded `uncertain`, is     *)
(* left as it is (635-638). Any other rejected step is rewritten "failed", *)
(* keeping its `attempts`, its `exhausted` flag and the command named on   *)
(* it (639-654), so an exhausted step stays exhausted.                     *)
(***************************************************************************)
RevalidateFinish(reject) ==
  /\ reval = "checking"
  /\ lease = "revalidation"                           \* 613
  /\ runRev = revalRev /\ runStatus # "cancelled"     \* 614-618
  /\ reject = "step" => node = "complete"             \* 576
  /\ reval' = "idle"
  /\ lease' = "free"                                  \* 662
  /\ IF reject = "nothing"
     THEN UNCHANGED << runStatus, runRev, node, rejected, reopened >>
     ELSE /\ node' = IF node = "pending" THEN "pending"            \* 635-636
                     ELSE IF node \in {"uncertain", "exhausted"}
                             /\ ~RevalidateReopens                 \* 637, 650
                          THEN node
                          ELSE "failed"                            \* 639-654
          /\ runStatus' = "active"                                 \* 656-661
          /\ runRev' = runRev + 1
          /\ rejected' = rejected \cup {c \in Commands : cmd[c] = "complete"}
          /\ reopened' = (reopened \/ (node = "uncertain" /\ node' = "failed"))
  /\ UNCHANGED << holder, cmd, outbox, worker, result, expRev, revalRev,
                  revalLeft, calls, blind, superseded, lateCommit >>
  /\ UNCHANGED recVars

\* The revalidate() call dies, is denied (582-583, 621-628) or is refused
\* (613-618). Nothing is written and its lease is not released.
RevalidationAbandoned ==
  /\ reval = "checking"
  /\ reval' = "idle"
  /\ UNCHANGED << runStatus, runRev, node, holder, cmd, outbox, lease, worker,
                  result, expRev, revalRev, revalLeft, calls, blind, rejected, reopened,
                  superseded, lateCommit >>
  /\ UNCHANGED recVars

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
\* was finding 4 and happens only with RevalidateReopens; this rule leaves it
\* to NeverBlindRepeat and UncertainStaysBlocked.
OneCallPerStep == reopened \/ ~blind

\* A command recorded `complete` has its step recorded complete and
\* verified, unless a revalidation rejected the step afterwards.
CompleteStaysVerified ==
  \A c \in Commands : (cmd[c] = "complete" /\ c \notin rejected) => node = "complete"

\* While a command is recorded `uncertain`, its step is recorded
\* `uncertain`, which is what keeps every new command out (930-932). An
\* operation registered with replay "read-only" may be run again instead,
\* so the rule is about every other operation.
UncertainStaysBlocked ==
  \/ Replay = "read-only"
  \/ \A c \in Commands : cmd[c] = "uncertain" => node = "uncertain"

\* Every command recorded `uncertain` has a reconciliation entry,
\* `reconciliation:<commandId>` with task "reconciliation-required", in the
\* outbox. This includes a command whose handler threw or returned
\* `uncertain` and whose result was committed (1055-1058, 1119-1158). The
\* entry stays pending, except that for an operation registered with replay
\* "read-only" it is resolved once another command for the step is recorded
\* complete (1136-1140).
UncertainIsReconciled ==
  \A c \in Commands :
    cmd[c] = "uncertain" =>
      /\ c \in outbox
      /\ c \in resolved =>
           /\ Replay = "read-only"
           /\ \E d \in Commands \ {c} : cmd[d] = "complete"

\* Every step recorded `uncertain` has a declared way to be resolved: in an
\* active run, an operation registered with replay "read-only" may be run
\* again by a new command id; any other operation, and any step of a run
\* that can no longer run, has a pending reconciliation entry for the
\* command named on the step.
UncertainHasWayOut ==
  node = "uncertain" =>
    IF Replay = "read-only" /\ runStatus = "active"
    THEN "uncertain" \in AdmitFrom
    ELSE holder \in outbox \ resolved

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
