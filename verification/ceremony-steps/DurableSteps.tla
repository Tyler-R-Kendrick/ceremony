---------------------------- MODULE DurableSteps ----------------------------
(***************************************************************************)
(* The database path of CeremonyController (src/server/controller.ts):     *)
(* the controller built with the `database` option, run by several        *)
(* workers that share one CeremonyDatabase (src/server/storage.ts).        *)
(*                                                                         *)
(* Each worker is one process with its own CeremonyController, its own     *)
(* in-memory store and its own adapter.  The database holds the stored     *)
(* snapshot (`instance:<id>`) and one lease row per ceremony                *)
(* (`instance:<id>` in the `leases` table).                                 *)
(*                                                                         *)
(* A step of this model is one stretch of JavaScript that runs without an  *)
(* `await` that waits on the network: a request that makes no adapter call *)
(* is one step (acquire, instance(), the checks, update() and persist(),   *)
(* release); a request that calls the adapter is two (the request is       *)
(* accepted and the call starts; the answer is applied, persisted and the  *)
(* lease released).                                                         *)
(*                                                                         *)
(* The adapter is a recoverable one (controller.ts:99-103 refuses any      *)
(* other with a database): every worker's adapter can carry the attempt    *)
(* on, so the model lets it answer anything an oauth-code adapter can.     *)
(*                                                                         *)
(* README.md maps every action and variable to file:line.                  *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Workers,       \* the processes that share the database
  MaxRevision,   \* bound: how many times the stored snapshot may be written
  LeaseRunsOut,  \* TRUE: a lease may run out while its request waits on the adapter
  Removed        \* checks taken out of the model on purpose; {} is the code as written

(***************************************************************************)
(* Each name in Removed takes one check out, to show a rule can fail.      *)
(* The code has every one of them.                                         *)
(*   "lease"                storage.ts:98-112  acquire refuses while an    *)
(*                          unexpired lease row for the ceremony exists    *)
(*   "reload-each-request"  controller.ts:274-299  instance() reads the    *)
(*                          stored snapshot on every request that finds    *)
(*                          the worker idle; removed, it reads it only     *)
(*                          when the worker has no copy                    *)
(***************************************************************************)
Checks == {"lease", "reload-each-request"}

Steps == {"intro", "redirect", "complete", "error", "cancelled", "expired"}
EndSteps == {"complete", "cancelled", "expired"}             \* controller.ts:304
Flights == {"none", "begin", "callback", "poll"}
Owns == {"none", "authenticated"}

\* A snapshot: snapshot.step, snapshot.revision, snapshot.outcome?.ownership,
\* and whether snapshot.expiresAt <= now().
Snap == [step : Steps, rev : Nat, own : Owns, late : BOOLEAN]
NoCopy == [step |-> "none", rev |-> 0, own |-> "none", late |-> FALSE]

ASSUME /\ Workers # {}
       /\ MaxRevision \in Nat
       /\ LeaseRunsOut \in BOOLEAN
       /\ Removed \subseteq Checks

VARIABLES
  db,          \* the stored snapshot, database record instance:<id>
  mem,         \* each worker's in-memory copy, store.get(id).snapshot; NoCopy if none
  flight,      \* each worker's adapter call in flight; instance.busy is flight # "none"
  lease,       \* the worker whose request holds the lease row, or "none"
  seen,        \* the revision on the person's screen
  writes,      \* how many times the stored snapshot has been written
  staleWrite,  \* ghost: a worker wrote over a stored snapshot it had not read
  reloadMoved  \* ghost: a reload replaced an end step with one that is not newer

vars == <<db, mem, flight, lease, seen, writes, staleWrite, reloadMoved>>

Has(check) == check \notin Removed

\* actionsFor, schema.ts:317-344, for an outcome that is not anonymous
ActionsFor(s) ==
  CASE s = "intro" -> {"begin", "cancel"}
    [] s = "redirect" -> {"cancel"}
    [] s = "complete" -> {}
    [] s \in {"error", "expired"} -> {"retry", "cancel"}
    [] s = "cancelled" -> {"retry"}

---------------------------------------------------------------------------
(* What every request does first                                           *)

\* database.acquire(`instance:${id}`), controller.ts:410, :438, :617.  A
\* lease row that has run out is deleted first (storage.ts:100-102).
Free == ~Has("lease") \/ lease = "none"

\* instance(), controller.ts:274-299: the stored snapshot replaces the
\* worker's copy unless the worker is busy.
Reloads(w) ==
  /\ flight[w] = "none"
  /\ Has("reload-each-request") \/ mem[w] = NoCopy

\* The copy the request works on.
Loaded(w) == IF Reloads(w) THEN db ELSE mem[w]

\* The reload replaced a copy on an end step with a stored snapshot that is
\* on another step and not newer.
MovesAnEndStep(w) ==
  /\ Reloads(w)
  /\ mem[w] # NoCopy
  /\ mem[w].step \in EndSteps
  /\ db.step # mem[w].step
  /\ db.rev <= mem[w].rev

\* Every request: acquire, then instance().
Enter(w) ==
  /\ Free
  /\ reloadMoved' = (reloadMoved \/ MovesAnEndStep(w))

\* instance(), controller.ts:303-312: an expired attempt is expired first.
Due(c) == c.step \notin EndSteps /\ c.late

\* update() then persist(), controller.ts:315-385.  `base` is the copy the
\* update starts from; persist() writes the new snapshot whatever is stored.
Write(base, new) ==
  /\ db' = new
  /\ writes' = writes + 1
  /\ staleWrite' = (staleWrite \/ base # db)

Next1(c, s, o) == [step |-> s, rev |-> c.rev + 1, own |-> o, late |-> c.late]

Release(w) == lease' = IF lease = w THEN "none" ELSE lease   \* release(id, token)

---------------------------------------------------------------------------
(* Requests                                                                *)

\* Any request that finds the attempt past its deadline: instance() expires
\* it and persists that (controller.ts:303-312).  The request then fails
\* its own checks or returns the expired snapshot.
Expire(w) ==
  /\ Enter(w)
  /\ LET c == Loaded(w) IN
       /\ Due(c)
       /\ Write(c, Next1(c, "expired", c.own))
       /\ mem' = [mem EXCEPT ![w] = Next1(c, "expired", c.own)]
  /\ UNCHANGED <<flight, lease, seen>>

\* read(), controller.ts:409-432, when it does not poll (the step is not
\* redirect, the worker is busy, or the one-second throttle holds it back).
Read(w) ==
  /\ Enter(w)
  /\ LET c == Loaded(w) IN
       /\ ~Due(c)
       /\ mem' = [mem EXCEPT ![w] = c]
       /\ seen' = c.rev
  /\ UNCHANGED <<db, flight, lease, writes, staleWrite>>

\* read() polls the adapter on redirect, which only the database path
\* does: controller.ts:422-430.  The lease is held until the answer.
ReadPolls(w) ==
  /\ Enter(w)
  /\ LET c == Loaded(w) IN
       /\ ~Due(c)
       /\ c.step = "redirect"
       /\ flight[w] = "none"
       /\ mem' = [mem EXCEPT ![w] = c]
  /\ flight' = [flight EXCEPT ![w] = "poll"]
  /\ lease' = w
  /\ UNCHANGED <<db, seen, writes, staleWrite>>

\* actLocked's checks, controller.ts:516-524
Accepts(w, c, a) ==
  /\ ~Due(c)
  /\ seen = c.rev
  /\ flight[w] = "none"
  /\ a \in ActionsFor(c.step)

\* case "begin", controller.ts:545-547.  The lease is held until the answer.
ActBegin(w) ==
  /\ Enter(w)
  /\ LET c == Loaded(w) IN
       /\ Accepts(w, c, "begin")
       /\ mem' = [mem EXCEPT ![w] = c]
  /\ flight' = [flight EXCEPT ![w] = "begin"]
  /\ lease' = w
  /\ UNCHANGED <<db, seen, writes, staleWrite>>

\* case "cancel", controller.ts:599-608
ActCancel(w) ==
  /\ Enter(w)
  /\ LET c == Loaded(w) IN
       /\ Accepts(w, c, "cancel")
       /\ Write(c, Next1(c, "cancelled", c.own))
       /\ mem' = [mem EXCEPT ![w] = Next1(c, "cancelled", c.own)]
  /\ UNCHANGED <<flight, lease, seen>>

\* case "retry", controller.ts:569-598, for an adapter without retry(): a
\* new adapter, the first step, a new deadline, and the outcome dropped.
ActRetry(w) ==
  /\ Enter(w)
  /\ LET c == Loaded(w)
         n == [step |-> "intro", rev |-> c.rev + 1, own |-> "none", late |-> FALSE]
     IN /\ Accepts(w, c, "retry")
        /\ Write(c, n)
        /\ mem' = [mem EXCEPT ![w] = n]
  /\ UNCHANGED <<flight, lease, seen>>

\* callback(), controller.ts:612-634.  The lease is held until the answer.
Callback(w) ==
  /\ Enter(w)
  /\ LET c == Loaded(w) IN
       /\ ~Due(c)
       /\ c.step = "redirect"
       /\ flight[w] = "none"
       /\ mem' = [mem EXCEPT ![w] = c]
  /\ flight' = [flight EXCEPT ![w] = "callback"]
  /\ lease' = w
  /\ UNCHANGED <<db, seen, writes, staleWrite>>

---------------------------------------------------------------------------
(* The adapter's answers: run(), controller.ts:635-671, then the release   *)
(* in the request's finally (controller.ts:414, :454, :621).               *)

\* What the adapter can answer to each call: begin returns redirect; a
\* callback returns complete or throws; a poll returns nothing, returns
\* complete, or throws.  "nothing" is poll() returning undefined.
Answers(f) ==
  CASE f = "begin" -> {[step |-> "redirect", own |-> "none"]}
    [] f = "callback" -> {[step |-> "complete", own |-> "authenticated"],
                          [step |-> "error", own |-> "none"]}
    [] f = "poll" -> {[step |-> "nothing", own |-> "none"],
                      [step |-> "complete", own |-> "authenticated"],
                      [step |-> "error", own |-> "none"]}

\* run() applies an answer, or the error, unless the worker's own copy is
\* expired (controller.ts:643, :660); update() returns early when nothing
\* changes (controller.ts:321-328).  It reads only the worker's copy.
Answer(w) ==
  /\ flight[w] # "none"
  /\ \E r \in Answers(flight[w]) :
       LET base == mem[w]
           own == IF r.own = "none" THEN base.own ELSE r.own
       IN IF r.step = "nothing" \/ base.step = "expired"
             \/ (r.step = base.step /\ own = base.own)
          THEN UNCHANGED <<db, mem, writes, staleWrite>>
          ELSE /\ Write(base, Next1(base, r.step, own))
               /\ mem' = [mem EXCEPT ![w] = Next1(base, r.step, own)]
  /\ flight' = [flight EXCEPT ![w] = "none"]
  /\ Release(w)
  /\ UNCHANGED <<seen, reloadMoved>>

---------------------------------------------------------------------------
(* Time                                                                    *)

\* The lease row's `expires` passes while its request waits on the adapter
\* (storage.ts:98: 60 seconds from acquire, never renewed).  The request
\* does not know.
LeaseExpires ==
  /\ LeaseRunsOut
  /\ lease # "none"
  /\ lease' = "none"
  /\ UNCHANGED <<db, mem, flight, seen, writes, staleWrite, reloadMoved>>

\* now() passes snapshot.expiresAt.  Every copy has the stored deadline or
\* an earlier one, so it passes for each of them too.
DeadlinePasses ==
  /\ ~db.late
  /\ db.step \notin EndSteps
  /\ db' = [db EXCEPT !.late = TRUE]
  /\ mem' = [w \in Workers |->
               IF mem[w] = NoCopy THEN NoCopy ELSE [mem[w] EXCEPT !.late = TRUE]]
  /\ UNCHANGED <<flight, lease, seen, writes, staleWrite, reloadMoved>>

---------------------------------------------------------------------------
First == CHOOSE w \in Workers : TRUE

\* start(), controller.ts:208-272, on the first worker: revision 0 on
\* intro, stored by persist().
Init ==
  /\ db = [step |-> "intro", rev |-> 0, own |-> "none", late |-> FALSE]
  /\ mem = [w \in Workers |-> IF w = First THEN db ELSE NoCopy]
  /\ flight = [w \in Workers |-> "none"]
  /\ lease = "none"
  /\ seen = 0
  /\ writes = 0
  /\ staleWrite = FALSE
  /\ reloadMoved = FALSE

Next ==
  \/ \E w \in Workers :
       \/ Expire(w) \/ Read(w) \/ ReadPolls(w)
       \/ ActBegin(w) \/ ActCancel(w) \/ ActRetry(w) \/ Callback(w)
       \/ Answer(w)
  \/ LeaseExpires
  \/ DeadlinePasses

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* The rules                                                               *)

TypeOK ==
  /\ db \in Snap
  /\ \A w \in Workers : mem[w] \in Snap \cup {NoCopy}
  /\ \A w \in Workers : flight[w] \in Flights
  /\ lease \in Workers \cup {"none"}
  /\ seen \in Nat
  /\ writes \in Nat
  /\ staleWrite \in BOOLEAN
  /\ reloadMoved \in BOOLEAN

\* A lease that runs out during an adapter call cannot let two workers apply
\* answers: every write to the stored snapshot starts from the stored
\* snapshot, so no worker writes over a change it has not read.
OneWorkerAppliesAnswers == ~staleWrite

\* A reload never moves a final step: a worker that held a copy on
\* complete, cancelled or expired reloads either that step or a newer one.
ReloadNeverMovesAnEndStep == ~reloadMoved

\* "Connected" is stored only with an outcome behind it.
ConnectedMeansConfirmed == db.step = "complete" => db.own = "authenticated"

\* Every stored step but complete offers the person a button.
EveryScreenOffersAWayOn == db.step = "complete" \/ ActionsFor(db.step) # {}

\* Bound for the checks: the stored snapshot is written at most MaxRevision times.
Bounded == writes <= MaxRevision
=============================================================================
