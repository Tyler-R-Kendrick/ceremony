--------------------------- MODULE CeremonySteps ---------------------------
(***************************************************************************)
(* One ceremony instance of the in-memory CeremonyController               *)
(* (src/server/controller.ts) driving one adapter made by                  *)
(* createProtocolAdapter (src/server/adapters.ts).                         *)
(*                                                                         *)
(* A step of this model is one stretch of JavaScript that runs without an  *)
(* `await` that waits on the network.  A provider call is two steps: the   *)
(* request is accepted and `busy` is set, and later the adapter's answer   *)
(* is applied.  Anything else can happen in between.                       *)
(*                                                                         *)
(* README.md maps every action and variable to file:line.                  *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Kinds,         \* the flow kinds to check, a subset of flowKinds (schema.ts:5-14)
  MaxRevision,   \* bound: how many times the snapshot may change
  StaleTabs,     \* TRUE: the person may press a button on a screen that is out of date
  RequestHuman,  \* TRUE: the adapter implements requestHuman (controller.ts:41)
  Removed        \* checks taken out of the model on purpose; {} is the code as written

(***************************************************************************)
(* Each name in Removed takes one check out, to show a rule can fail.      *)
(* The code has every one of them.                                         *)
(*   "revision-check"       controller.ts:518  revision !== snapshot.revision *)
(*   "busy-check"           controller.ts:518  || instance.busy             *)
(*   "offered-check"        controller.ts:523  !snapshot.actions.includes   *)
(*   "end-exemption"        controller.ts:304  complete, cancelled and      *)
(*                          expired are never expired                       *)
(*   "expired-guard"        controller.ts:643  step !== "expired", for an   *)
(*                          answer the adapter returns                      *)
(*   "human-expired-guard"  controller.ts:539  step !== "expired", for a    *)
(*                          requestHuman answer                             *)
(*   "expired-guard-on-error" controller.ts:660 step !== "expired", for an  *)
(*                          error the adapter throws                        *)
(*   "callback-guard"       controller.ts:630  step !== "redirect"          *)
(*   "revision-bump"        controller.ts:336  revision: previous.revision+1*)
(*   "retry-keeps-revision" controller.ts:588  retry goes through update(), *)
(*                          so the revision carries on; removed, retry      *)
(*                          starts again at 0 as startLocked does (:248)    *)
(*   "retry-after-cancel"   schema.ts:322-323  cancelled offers "retry"     *)
(*   "retry-drops-outcome"  controller.ts:595  retry drops an outcome that  *)
(*                          is not claimed; removed, update() keeps it      *)
(***************************************************************************)
Checks == {"revision-check", "busy-check", "offered-check", "end-exemption",
           "expired-guard", "human-expired-guard", "expired-guard-on-error",
           "callback-guard",
           "revision-bump", "retry-keeps-revision", "retry-after-cancel",
           "retry-drops-outcome"}

Steps == {"intro", "input", "redirect", "waiting", "anonymous", "claim",
          "complete", "error", "cancelled", "expired"}       \* schema.ts:189-200
ActionNames == {"begin", "submit", "claim", "finish", "retry", "cancel",
                "request-human"}                             \* schema.ts:202-210
BuiltInKinds == {"api-key", "basic", "form", "oauth-code", "device",
                 "authmd-anonymous"}
InputKinds == {"api-key", "basic", "form"}
EndSteps == {"complete", "cancelled", "expired"}             \* controller.ts:304
Flights == {"none", "begin", "submit", "submit-claim", "callback", "poll",
            "human-redirect", "human-input"}

ASSUME /\ Kinds \subseteq BuiltInKinds
       /\ Kinds # {}
       /\ MaxRevision \in Nat
       /\ StaleTabs \in BOOLEAN
       /\ RequestHuman \in BOOLEAN
       /\ Removed \subseteq Checks

VARIABLES
  kind,       \* snapshot.method.kind
  step,       \* snapshot.step
  revision,   \* snapshot.revision
  own,        \* snapshot.outcome?.ownership, "none" when there is no outcome
  late,       \* snapshot.expiresAt <= now()
  codeAsked,  \* snapshot.fields is the verification code field (adapters.ts:363-372)
  flight,     \* the adapter call in flight; instance.busy is flight # "none"
  stopped,    \* adapter: stopped (adapters.ts:163)
  armed,      \* adapter: state and verifier are set (adapters.ts:155-156)
  holds,      \* adapter: this adapter obtained an outcome (adapters.ts:171)
  seen,       \* the screen in the person's tab: its revision, and which screen it is
  shown,      \* ghost: how many times the snapshot has changed
  staleAccepted,  \* ghost: an action from an out-of-date screen was accepted
  endMoved        \* ghost: who moved an end screen, if it was not the person

snapshot == <<step, revision, own, late, codeAsked, shown, endMoved>>
adapter == <<stopped, armed, holds>>
vars == <<kind, step, revision, own, late, codeAsked, flight, stopped, armed,
          holds, seen, shown, staleAccepted, endMoved>>

Has(check) == check \notin Removed

\* controller.ts:237-239 and :583-585
InitialStep == IF kind \in InputKinds THEN "input" ELSE "intro"

\* actionsFor, schema.ts:317-344
ActionsFor(s, anonymous) ==
  CASE s = "cancelled" -> IF Has("retry-after-cancel") THEN {"retry"} ELSE {}
    [] s = "complete" -> IF anonymous THEN {"claim"} ELSE {}
    [] s = "intro" -> {"begin", "cancel"}
    [] s \in {"input", "claim"} -> {"submit", "cancel"}
    [] s = "anonymous" -> {"finish", "claim", "cancel"}
    [] s \in {"redirect", "waiting"} -> {"cancel"}
    [] s \in {"error", "expired"} ->
         IF anonymous THEN {"finish", "claim", "cancel"} ELSE {"retry", "cancel"}

\* snapshot.actions.  It is stored, but update() recomputes it from the step
\* and the outcome every time: controller.ts:259-261, :344, :358-362.
Offered ==
  ActionsFor(step, own = "anonymous")
    \cup (IF RequestHuman /\ step \in {"redirect", "input"}
          THEN {"request-human"} ELSE {})

Screen == [rev |-> revision, n |-> shown]

\* The person's tab.  With StaleTabs it only changes when the person looks
\* again; without, the person always has the current screen.
Tab == seen' = IF StaleTabs THEN seen ELSE [rev |-> revision', n |-> shown']

NextRevision == IF Has("revision-bump") THEN revision + 1 ELSE revision

Same == UNCHANGED snapshot

\* update(), controller.ts:315-364, when something differs.  `by` is who
\* caused it: "you" for an accepted action, "provider" for an adapter answer,
\* "clock" for expiry.
ChangeAt(s, o, renew, code, by, rev) ==
  /\ step' = s
  /\ own' = o
  /\ late' = (late /\ ~renew)
  /\ codeAsked' = code
  /\ revision' = rev
  /\ shown' = shown + 1
  /\ endMoved' = IF step \in EndSteps /\ by # "you"
                 THEN [from |-> step, by |-> by] ELSE endMoved

Change(s, o, renew, code, by) == ChangeAt(s, o, renew, code, by, NextRevision)

\* update() returns early when the update repeats the snapshot: controller.ts:321-328.
Update(s, o, renew, code, by) ==
  IF s = step /\ o = own /\ ~renew /\ code = codeAsked
  THEN Same
  ELSE Change(s, o, renew, code, by)

\* adapter.cancel(), adapters.ts:491-497
AdapterCancel == stopped' = TRUE /\ armed' = FALSE

\* instance(), controller.ts:303-312, runs first in every request.  Without
\* the exemption, expiring an expired snapshot is an update that repeats it.
ExpiryDue ==
  /\ late
  /\ IF Has("end-exemption") THEN step \notin EndSteps ELSE step # "expired"

\* actLocked's checks, controller.ts:516-524.  A client can send any action
\* name with the revision of the screen it has.
Accepts(a) ==
  /\ ~ExpiryDue
  /\ ~Has("revision-check") \/ seen.rev = revision
  /\ ~Has("busy-check") \/ flight = "none"
  /\ ~Has("offered-check") \/ a \in Offered

Press(a) ==
  /\ Accepts(a)
  /\ staleAccepted' = (staleAccepted \/ seen.n # shown)

\* A success answer in run(), controller.ts:641-644.
Applies == ~Has("expired-guard") \/ step # "expired"

\* The catch in run() for an error while the step is not "waiting":
\* controller.ts:660-667.
ErrorUpdate ==
  IF Has("expired-guard-on-error") /\ step = "expired" THEN Same
  ELSE Update("error", own, FALSE, FALSE, "provider")

---------------------------------------------------------------------------
(* The person's actions: actLocked, controller.ts:508-611                  *)

\* case "begin", :545-547.  adapter.begin runs to its first await:
\* adapters.ts:229-232.
ActBegin ==
  /\ Press("begin")
  /\ flight = "none"  \* the model has one provider call in flight at a time
  /\ flight' = "begin"
  /\ stopped' = FALSE
  /\ armed' = (armed \/ kind = "oauth-code")
  /\ Same /\ Tab
  /\ UNCHANGED <<kind, holds>>

\* case "submit", :548-559.  For a claim, adapter.submit checks the claim
\* token before it clears `stopped`: adapters.ts:300-305.
ActSubmit ==
  /\ Press("submit")
  /\ flight = "none"
  /\ LET claimPath == step = "claim" /\ kind = "authmd-anonymous" IN
       /\ flight' = IF claimPath THEN "submit-claim" ELSE "submit"
       /\ stopped' = IF claimPath /\ holds THEN FALSE ELSE stopped
  /\ Same /\ Tab
  /\ UNCHANGED <<kind, armed, holds>>

\* case "claim", :560-565
ActClaim ==
  /\ Press("claim")
  /\ Change("claim", own, TRUE, FALSE, "you")
  /\ Tab
  /\ UNCHANGED <<kind, flight, adapter>>

\* case "finish", :566-568
ActFinish ==
  /\ Press("finish")
  /\ Update("complete", own, FALSE, FALSE, "you")
  /\ Tab
  /\ UNCHANGED <<kind, flight, adapter>>

\* case "retry", :569-598.  The protocol adapter has no retry(), so the
\* controller cancels it, makes a new one and goes back to the first step.
\* update() drops previous.outcome unless it is claimed (:595, :329-333).
\* Without "retry-drops-outcome", update() keeps it and `own` carries over.
RetryOwn ==
  IF Has("retry-drops-outcome") /\ own # "claimed" THEN "none" ELSE own

ActRetry ==
  /\ Press("retry")
  /\ stopped' = FALSE /\ armed' = FALSE /\ holds' = FALSE
  /\ ChangeAt(InitialStep, RetryOwn, TRUE, FALSE, "you",
              IF Has("retry-keeps-revision") THEN NextRevision ELSE 0)
  /\ Tab
  /\ UNCHANGED <<kind, flight>>

\* case "cancel", :599-608
ActCancel ==
  /\ Press("cancel")
  /\ AdapterCancel
  /\ Update(IF own = "anonymous" /\ step # "anonymous" THEN "anonymous" ELSE "cancelled",
            own, FALSE, FALSE, "you")
  /\ Tab
  /\ UNCHANGED <<kind, flight, holds>>

\* case "request-human", :532-544.  The answer carries the step the adapter
\* projected before its await (github.ts:502, :520-524), which is the step
\* the request was accepted in.
ActRequestHuman ==
  /\ RequestHuman
  /\ Press("request-human")
  /\ flight = "none"
  /\ step \in {"redirect", "input"}
  /\ flight' = IF step = "redirect" THEN "human-redirect" ELSE "human-input"
  /\ Same /\ Tab
  /\ UNCHANGED <<kind, adapter>>

---------------------------------------------------------------------------
(* The adapter's answers: run(), controller.ts:635-671                     *)

\* adapter.begin returns: adapters.ts:243 (oauth-code), :261-266 (device),
\* :288-295 (authmd-anonymous), :297 (the others).
BeginReturns ==
  /\ flight = "begin"
  /\ flight' = "none"
  /\ holds' = (holds \/ kind = "authmd-anonymous")
  /\ IF ~Applies THEN Same
     ELSE CASE kind = "oauth-code" -> Update("redirect", own, FALSE, FALSE, "provider")
            [] kind = "device" -> Update("waiting", own, TRUE, FALSE, "provider")
            [] kind = "authmd-anonymous" ->
                 Update("anonymous", "anonymous", TRUE, FALSE, "provider")
            [] OTHER -> Update("input", own, FALSE, FALSE, "provider")
  /\ Tab
  /\ UNCHANGED <<kind, stopped, armed, staleAccepted>>

\* adapter.begin throws: the device or anonymous request fails.  The
\* oauth-code branch makes no provider call.
BeginThrows ==
  /\ flight = "begin"
  /\ kind \in {"device", "authmd-anonymous"}
  /\ flight' = "none"
  /\ ErrorUpdate /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.submit returns complete: adapters.ts:380-383, :386-391
SubmitReturnsComplete ==
  /\ flight = "submit"
  /\ kind \in InputKinds
  /\ flight' = "none"
  /\ holds' = TRUE
  /\ IF Applies THEN Update("complete", "authenticated", FALSE, FALSE, "provider") ELSE Same
  /\ Tab
  /\ UNCHANGED <<kind, stopped, armed, staleAccepted>>

\* adapter.submit asks for the verification code: adapters.ts:356-378
SubmitReturnsCodeInput ==
  /\ flight = "submit"
  /\ kind = "form"
  /\ flight' = "none"
  /\ IF Applies THEN Update("input", own, FALSE, TRUE, "provider") ELSE Same
  /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.submit starts the claim approval: adapters.ts:318-329
SubmitReturnsWaiting ==
  /\ flight = "submit-claim"
  /\ holds
  /\ flight' = "none"
  /\ IF Applies THEN Update("waiting", own, TRUE, FALSE, "provider") ELSE Same
  /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.submit throws: rejected credentials, no claim token
\* (adapters.ts:301-304), or a kind that takes no fields (:331-332).
SubmitThrows ==
  /\ flight \in {"submit", "submit-claim"}
  /\ flight' = "none"
  /\ ErrorUpdate /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* controller.callback, :612-634, then adapter.callback to its first await,
\* adapters.ts:393-399.  A callback can arrive at any time; without state
\* the adapter throws at once.
Callback ==
  /\ ~ExpiryDue
  /\ flight = "none"
  /\ ~Has("callback-guard") \/ step = "redirect"
  /\ IF stopped \/ ~armed
     THEN ErrorUpdate /\ UNCHANGED <<flight, armed>>
     ELSE flight' = "callback" /\ armed' = FALSE /\ Same
  /\ Tab
  /\ UNCHANGED <<kind, stopped, holds, staleAccepted>>

\* adapter.callback returns: adapters.ts:420
CallbackReturns ==
  /\ flight = "callback"
  /\ flight' = "none"
  /\ holds' = TRUE
  /\ IF Applies THEN Update("complete", "authenticated", FALSE, FALSE, "provider") ELSE Same
  /\ Tab
  /\ UNCHANGED <<kind, stopped, armed, staleAccepted>>

\* adapter.callback throws: wrong state, denied, or the token exchange fails
CallbackThrows ==
  /\ flight = "callback"
  /\ flight' = "none"
  /\ ErrorUpdate /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* read() polls while the step is "waiting": controller.ts:422-430.  A
\* stopped adapter returns at once: adapters.ts:423.
ReadPolls ==
  /\ ~ExpiryDue
  /\ step = "waiting"
  /\ flight = "none"
  /\ ~stopped
  /\ flight' = "poll"
  /\ Same /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.poll returns undefined: authorization_pending or slow_down
PollReturnsNothing ==
  /\ flight = "poll"
  /\ flight' = "none"
  /\ Same /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.poll returns complete: adapters.ts:449-456 (claim), :470-473 (device)
PollReturnsComplete ==
  /\ flight = "poll"
  /\ flight' = "none"
  /\ holds' = TRUE
  /\ IF Applies
     THEN Update("complete",
                 IF kind = "authmd-anonymous" THEN "claimed" ELSE "authenticated",
                 FALSE, FALSE, "provider")
     ELSE Same
  /\ Tab
  /\ UNCHANGED <<kind, stopped, armed, staleAccepted>>

\* adapter.poll throws a CeremonyError: denied or expired_token
PollThrowsCeremonyError ==
  /\ flight = "poll"
  /\ flight' = "none"
  /\ ErrorUpdate /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.poll throws another error while the step is "waiting":
\* controller.ts:646-659 keeps the step and sets a message.  The message
\* is new the first time and the same after that.
PollThrowsOther ==
  /\ flight = "poll"
  /\ flight' = "none"
  /\ IF step = "waiting"
     THEN Same \/ Change("waiting", own, FALSE, FALSE, "provider")
     ELSE ErrorUpdate
  /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.requestHuman returns, controller.ts:537, and controller.ts:539-540
\* applies it unless the snapshot is "expired".  There is no other check that
\* the snapshot is still the one the request was accepted on.  The answer may
\* carry its own expiresAt (github.ts:468).
RequestHumanReturns ==
  /\ flight \in {"human-redirect", "human-input"}
  /\ flight' = "none"
  /\ IF Has("human-expired-guard") /\ step = "expired"
     THEN Same
     ELSE \E renew \in BOOLEAN :
            Change(IF flight = "human-redirect" THEN "redirect" ELSE "input",
                   own, renew, codeAsked, "provider")
  /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

\* adapter.requestHuman throws: controller.ts:536-543 only clears busy
RequestHumanThrows ==
  /\ flight \in {"human-redirect", "human-input"}
  /\ flight' = "none"
  /\ Same /\ Tab
  /\ UNCHANGED <<kind, adapter, staleAccepted>>

---------------------------------------------------------------------------
(* Time, and the person's tab                                              *)

\* now() passes snapshot.expiresAt.  On an end screen that matters only
\* without the exemption.
DeadlinePasses ==
  /\ ~late
  /\ step \notin EndSteps \/ ~Has("end-exemption")
  /\ late' = TRUE
  /\ UNCHANGED <<kind, step, revision, own, codeAsked, flight, adapter, seen,
                 shown, staleAccepted, endMoved>>

\* instance(), controller.ts:303-312: the next request of any sort, a read
\* included, expires the snapshot before it does anything else.
ExpireOnAccess ==
  /\ ExpiryDue
  /\ AdapterCancel
  /\ Change("expired", own, FALSE, FALSE, "clock")
  /\ Tab
  /\ UNCHANGED <<kind, flight, holds, staleAccepted>>

\* The person looks at the page again: read(), controller.ts:409-432
TabRefreshes ==
  /\ StaleTabs
  /\ ~ExpiryDue
  /\ seen # Screen
  /\ seen' = Screen
  /\ UNCHANGED <<kind, flight, adapter, staleAccepted>> /\ Same

\* The one true end: connected, and nothing left to offer.
Done ==
  /\ step = "complete"
  /\ Offered = {}
  /\ flight = "none"
  /\ UNCHANGED vars

---------------------------------------------------------------------------
Init ==
  /\ kind \in Kinds
  /\ step = InitialStep
  /\ revision = 0
  /\ own = "none"
  /\ late = FALSE
  /\ codeAsked = FALSE
  /\ flight = "none"
  /\ stopped = FALSE /\ armed = FALSE /\ holds = FALSE
  /\ seen = [rev |-> 0, n |-> 0]
  /\ shown = 0
  /\ staleAccepted = FALSE
  /\ endMoved = [from |-> "none", by |-> "none"]

Next ==
  \/ ActBegin \/ ActSubmit \/ ActClaim \/ ActFinish \/ ActRetry \/ ActCancel
  \/ ActRequestHuman
  \/ BeginReturns \/ BeginThrows
  \/ SubmitReturnsComplete \/ SubmitReturnsCodeInput \/ SubmitReturnsWaiting
  \/ SubmitThrows
  \/ Callback \/ CallbackReturns \/ CallbackThrows
  \/ ReadPolls \/ PollReturnsNothing \/ PollReturnsComplete
  \/ PollThrowsCeremonyError \/ PollThrowsOther
  \/ RequestHumanReturns \/ RequestHumanThrows
  \/ DeadlinePasses \/ ExpireOnAccess \/ TabRefreshes
  \/ Done

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* The rules                                                               *)

TypeOK ==
  /\ kind \in Kinds
  /\ step \in Steps
  /\ revision \in Nat
  /\ own \in {"none", "authenticated", "anonymous", "claimed"}
  /\ late \in BOOLEAN /\ codeAsked \in BOOLEAN
  /\ flight \in Flights
  /\ stopped \in BOOLEAN /\ armed \in BOOLEAN /\ holds \in BOOLEAN
  /\ seen.rev \in Nat /\ seen.n \in Nat
  /\ shown \in Nat
  /\ staleAccepted \in BOOLEAN

\* An action is accepted only from the screen the server holds now.
YouActOnTheScreenYouSee == ~staleAccepted

\* "Connected" is shown only with an outcome behind it.
ConnectedMeansConfirmed == step = "complete" => own # "none"

\* Connected, cancelled and expired change only when the person presses a
\* button that screen offers.  No provider answer and no clock moves them.
EndScreensStayPut == endMoved.by = "none"

\* Every screen but the last one offers the person a button.
EveryScreenOffersAWayOn == step = "complete" \/ Offered # {}

\* Finding F2, fixed: a result on screen was obtained by the adapter that is
\* serving this attempt.  Retry makes a new adapter and drops the old result.
\* A claimed result is kept; it is reached only on "complete", which offers
\* no retry.
TryAgainStartsClean == own # "none" => holds

\* Bound for the checks: the snapshot changes at most MaxRevision times.
Bounded == shown <= MaxRevision

\* For the chart: the revision counts changes and nothing else depends on it
\* when the person always has the current screen.
ChartView == <<kind, step, own, late, codeAsked, flight, stopped, armed, holds,
               staleAccepted, endMoved>>
=============================================================================
