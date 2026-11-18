--------------------------- MODULE GitHubHandoff ---------------------------
(***************************************************************************)
(* "Connect GitHub" for ONE run: create the GitHub App, install it, get a  *)
(* token.  Models src/server/recipes/github.ts (AsyncGitHubChildren) and   *)
(* the parts of src/server/github-runtime.ts and src/server/commands.ts    *)
(* that decide which request may run when.  github.ts below always means   *)
(* src/server/recipes/github.ts.  Line numbers are those of the sync       *)
(* commit in README.md.                                                    *)
(*                                                                         *)
(* One action here is one store transaction in the code, or one GitHub     *)
(* call together with the transaction that follows it (the answer itself   *)
(* changes nothing that another request can see).  Whatever an awaited     *)
(* call separates in the code is a separate action here.                   *)
(*                                                                         *)
(* README.md maps every action and variable to its code, states the bounds *)
(* and lists what is left out.                                             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Returns,                  \* deliveries of "GitHub sends you back"; two of them model a replay

  \* --- what the surroundings may do ---
  GitHubFailsInReturn,      \* a GitHub call made while a page, a return or a recovery is handled may fail
  GitHubFailsInSteps,       \* the steps of the run (subset of {"app", "inst", "access"}) in which a
                            \*   GitHub call may fail
  WrongAccountPossible,     \* you may create the app while signed in to another GitHub account than
                            \*   the one you chose (github.ts:574 names the account only for an organization)
  RequestsDie,              \* the process handling a return or a recovery may die between transactions
  RequestsOverlap,          \* requests and timers may fall between another request's transactions
                            \*   (FALSE only in Chart.cfg, to draw the flow one request at a time)

  \* --- the code as written is TRUE; FALSE removes one check (see Broken*.cfg) ---
  AdmitComparesRevision,    \* github.ts:673  put(callbackKey, ..., record.revision)
  AppReadyAssertsFence,     \* github.ts:702  assertFence before "app-ready" is written
  SaveChecksCancelled,      \* github.ts:289-290  saveArtifact refuses a cancelled run
  ReturnChecksInstallation, \* github.ts:737  checkInstallation before the installation is recorded
  RerunUncertain,           \* github.ts:348  the steps registered replay "read-only": the engine runs
                            \*   such a step again from "uncertain" (commands.ts:927-937)
  RefusalLeavesRun,         \* github-runtime.ts:1327  the return route does not advance the run after
                            \*   a refused return (GitHubCallbackRefused, github.ts:647, 678, 730)
  ExpiryRetriesOnConflict   \* github.ts:428-433  prepare() reads the record again when its expiry
                            \*   write meets PersistenceConflict

VARIABLES
  \* the run and its three steps (commands.ts)
  run,          \* run record status: "active" | "cancelled"
  step,         \* node state of app / inst / access: "open" | "uncertain" | "complete"
                \*   "open" = pending, awaiting-human, verifying or failed: the engine may run it
  eng,          \* the step the engine is running now, with what prepare() read

  \* the shared setup record  handoff github-setup:{scope}  (github.ts:175-181)
  setup,        \* phase: "none" | "registration" | "converting" | "uncertain" | "app-ready" | "cancelled"
  issued,       \* handoffIssued: a hand-off page carrying the current nonce was rendered
  expired,      \* the registration hand-off's hour has passed (expires <= now)
  app,          \* the app and private key the record holds: "none" | "right" | "wrong"
                \*   "wrong" = an app of another account than the chosen one; verifyApp
                \*   (github.ts:248-265) rejects it every time
  claim,        \* returns holding the live fence on the setup key; {} when none

  \* the run's own record  handoff github:{runId}  (github.ts:168-174)
  local,        \* "none" | "shared" (points at the setup record) | "installation" | "installed" | "cancelled"
  instExpired,  \* the installation hand-off's hour has passed

  \* artifacts (github.ts:182-193, 284-295)
  appArt,       \* app artifact saved
  instArt,      \* installation artifact: "none" | "good" | "bad"
  token,        \* connection artifact with a token: "none" | "good" | "bad"

  \* requests in flight
  ret,          \* per return: where its handler is, and the installation id it carries
  page,         \* the registration hand-off page: "idle" | "open" | "stale"
  rec,          \* the recovery form: "idle" | "read" | "stale" | "stored"

  \* bookkeeping for the rules, not in the code
  converted,    \* conversions sent to GitHub for the current nonce
  created,      \* the app you created on GitHub for the current nonce: "none" | "right" | "wrong"
  haveRight,    \* you created an app under the chosen account, so you have one to enter
                \*   on the recovery page
  frozen,       \* what was recorded when the hand-off was cancelled
  deadSeen,     \* a dead end was reached before a timer ran out
  refusedMoved  \* a refused return made the engine run a step

vars == << run, step, eng, setup, issued, expired, app, claim, local,
           instExpired, appArt, instArt, token, ret, page, rec, converted,
           created, haveRight, frozen, deadSeen, refusedMoved >>

Steps == {"app", "inst", "access"}
Idle == [node |-> "none", sPhase |-> "none", sApp |-> "none", sIssued |-> FALSE, fresh |-> TRUE,
         tries |-> 0]
RetIdle == [pc |-> "idle", id |-> "none"]

\* The phase read() returns (github.ts:194-209): the setup record while the
\* run points at it, the run's own record afterwards.
Phase == IF local = "shared" THEN setup ELSE local

\* Nothing is in flight.  With RequestsOverlap = FALSE a request or a timer
\* starts only then; Cancel may still come at any moment.
Quiet == /\ eng.node = "none" /\ page = "idle" /\ rec = "idle"
         /\ \A c \in Returns : ret[c].pc = "idle"
MayStart == RequestsOverlap \/ Quiet

\* What must not change once the hand-off is cancelled.
Recorded == << local, appArt, instArt, token, setup = "cancelled",
               IF setup = "cancelled" THEN app ELSE "none" >>

TypeOK ==
  /\ run \in {"active", "cancelled"}
  /\ step \in [Steps -> {"open", "uncertain", "complete"}]
  /\ eng.node \in Steps \cup {"none"}
  /\ setup \in {"none", "registration", "converting", "uncertain", "app-ready", "cancelled"}
  /\ issued \in BOOLEAN /\ expired \in BOOLEAN
  /\ app \in {"none", "right", "wrong"} /\ created \in {"none", "right", "wrong"}
  /\ claim \subseteq Returns /\ Cardinality(claim) <= 1
  /\ local \in {"none", "shared", "installation", "installed", "cancelled"}
  /\ instExpired \in BOOLEAN /\ appArt \in BOOLEAN
  /\ instArt \in {"none", "good", "bad"} /\ token \in {"none", "good", "bad"}
  /\ \A c \in Returns :
       /\ ret[c].pc \in {"idle", "regRead", "regStale", "admitted", "saved", "instRead", "instStale"}
       /\ ret[c].id \in {"none", "good", "bad"}
  /\ page \in {"idle", "open", "stale"}
  /\ rec \in {"idle", "read", "stale", "stored"}
  /\ converted \in 0..3 /\ haveRight \in BOOLEAN /\ deadSeen \in BOOLEAN
  /\ refusedMoved \in BOOLEAN

Init ==
  /\ run = "active"
  /\ step = [n \in Steps |-> "open"]
  /\ eng = Idle
  /\ setup = "none" /\ issued = FALSE /\ expired = FALSE /\ app = "none"
  /\ claim = {}
  /\ local = "none" /\ instExpired = FALSE
  /\ appArt = FALSE /\ instArt = "none" /\ token = "none"
  /\ ret = [c \in Returns |-> RetIdle]
  /\ page = "idle" /\ rec = "idle"
  /\ converted = 0 /\ created = "none" /\ haveRight = FALSE /\ deadSeen = FALSE
  /\ refusedMoved = FALSE
  /\ frozen = << "none", FALSE, "none", "none", FALSE, "none" >>

(***************************************************************************)
(* Every put to a record moves its revision on (persistence/index.ts:      *)
(* 345-360).  A request that read the record earlier and writes with the   *)
(* revision it read then gets PersistenceConflict.  The model keeps no     *)
(* numbers: a writer marks the readers still holding the old revision.     *)
(***************************************************************************)
StaleRets(r) == [c \in Returns |->
                   IF r[c].pc = "regRead" THEN [r[c] EXCEPT !.pc = "regStale"] ELSE r[c]]
StaleInst(r) == [c \in Returns |->
                   IF r[c].pc = "instRead" THEN [r[c] EXCEPT !.pc = "instStale"] ELSE r[c]]
StaleEng == IF eng.node = "app" THEN [eng EXCEPT !.fresh = FALSE] ELSE eng
StaleRec == IF rec = "read" THEN "stale" ELSE rec
\* The page handler compares the nonce it read, not the revision (github.ts:560-565).
StalePage == IF page = "open" THEN "stale" ELSE page

\* The engine's last transaction writes the step's state only while the run
\* is active and its lease holds (commands.ts:1083-1135); cancel ends both.
Settle(n, result) ==
  /\ step' = IF run = "active" THEN [step EXCEPT ![n] = result] ELSE step
  /\ eng' = Idle

(***************************************************************************)
(* THE RUN ENGINE RUNS A STEP.  commands.ts:757-1255.                      *)
(* Anyone may ask for it at any time: the connection page (teaching.tsx:   *)
(* 1733-1757), the assistant's advance tool, and the return and hand-off   *)
(* routes themselves (github-runtime.ts:1328, 1342, 1353), each under a    *)
(* new command id.  The return route asks for it after a return that       *)
(* failed once admitted or arrived after the hour, never after a refused   *)
(* return (RefusalAnswered).  A step marked "complete" is                  *)
(* never run again; one marked "uncertain" is run again only when its      *)
(* operation is registered replay "read-only" (commands.ts:927-937), which *)
(* all three are (github.ts:348).                                          *)
(***************************************************************************)
\* What the engine holds when it starts step n: prepare() reads the
\* artifact and the hand-off first (github.ts:387-398).
Start(n) == [node |-> n,
             sPhase |-> IF n = "app" THEN Phase ELSE "none",
             sApp |-> IF n # "app" THEN "none"
                      ELSE IF appArt \/ local \in {"installation", "installed"} THEN "right"
                      ELSE IF local = "shared" THEN app
                      ELSE "none",
             sIssued |-> n = "app" /\ issued,
             fresh |-> TRUE,
             tries |-> 0]

StepStarts(n) ==
  /\ MayStart
  /\ run = "active" /\ eng.node = "none"
  /\ \/ step[n] = "open"
     \/ step[n] = "uncertain" /\ n \in RerunUncertain
  /\ \/ n = "app"
     \/ n = "inst" /\ step.app = "complete"
     \/ n = "access" /\ step.inst = "complete"
  /\ eng' = Start(n)
  /\ UNCHANGED << run, step, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* The guards of the outcomes that leave a step other than where it stood,
\* for the engine holding e.  The actions below use them with e = eng;
\* RerunMoves uses them with e = Start(n).
HandoffPreparedOn(e) ==
  e.node = "app" /\ e.sPhase = "none" /\ e.sApp = "none" /\ local = "none"
AppConfirmedOn(e) ==
  /\ e.node = "app" /\ e.sApp = "right" /\ e.sPhase # "cancelled"
  /\ ~(SaveChecksCancelled /\ local = "cancelled")
HandoffLapsedOn(e) ==
  e.node = "app" /\ e.sApp = "none" /\ e.sPhase = "registration" /\ expired
StepStillWaitingOn(e) ==
  e.node = "app" /\ e.sApp = "none" /\ e.sPhase = "registration" /\ ~expired
InstallHandoffPreparedOn(e) ==
  e.node = "inst" /\ instArt = "none" /\ local # "cancelled"
InstallConfirmedOn(e) == e.node = "inst" /\ instArt # "none"
TokenStoredOn(e) ==
  /\ e.node = "access" /\ instArt = "good"
  /\ ~(SaveChecksCancelled /\ local = "cancelled")

\* Running step n again from "uncertain" can end differently: with the step
\* no longer "uncertain", or with a record changed.  A rerun that can only
\* throw again, or report "uncertain" again, is no way forward.
RerunMoves(n) ==
  LET e == Start(n) IN
    \/ HandoffPreparedOn(e) \/ AppConfirmedOn(e)
    \/ HandoffLapsedOn(e) \/ StepStillWaitingOn(e)
    \/ InstallHandoffPreparedOn(e)
    \/ InstallConfirmedOn(e) /\ instArt = "good"
    \/ TokenStoredOn(e)

\* --- step "app": prepare(), github.ts:382-481 ---

\* First time: create the setup record and the run's pointer to it. github.ts:436-480
HandoffPrepared ==
  /\ HandoffPreparedOn(eng)
  /\ setup' = "registration" /\ local' = "shared"
  /\ issued' = FALSE /\ expired' = FALSE /\ converted' = 0 /\ created' = "none"
  /\ Settle("app", "open")
  /\ UNCHANGED << run, app, claim, instExpired, appArt, instArt, token,
                  ret, page, rec, haveRight, frozen, deadSeen, refusedMoved >>

\* An app is known: verify it with GitHub, save the artifact, then the
\* engine's own verify passes. github.ts:399-407, 284-295, 350-378
AppConfirmed ==
  /\ AppConfirmedOn(eng)
  /\ appArt' = TRUE
  /\ Settle("app", "complete")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, instArt, token, ret, page, rec, converted,
                  created, haveRight, frozen, deadSeen, refusedMoved >>

\* GitHub does not answer verifyApp (github.ts:400), or the engine's verify
\* after the artifact was saved (github.ts:358), or verifyApp rejects an app
\* of another account.  prepare() throws and the engine records "uncertain"
\* (commands.ts:1055-1058).
AppCheckUnanswered ==
  /\ eng.node = "app" /\ eng.sApp # "none" /\ eng.sPhase # "cancelled"
  /\ "app" \in GitHubFailsInSteps \/ eng.sApp = "wrong"
  /\ \E saved \in BOOLEAN :
       /\ saved => eng.sApp = "right" /\ ~(SaveChecksCancelled /\ local = "cancelled")
       /\ appArt' = (appArt \/ saved)
  /\ Settle("app", "uncertain")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, instArt, token, ret, page, rec, converted,
                  created, haveRight, frozen, deadSeen, refusedMoved >>

\* The registration hand-off's hour is over. github.ts:409-436
\*   page was rendered  -> "uncertain", nonce consumed (an app may exist)
\*   page never rendered -> a new nonce and a new hour
\* The put uses the revision prepare() read (github.ts:426).  If the record
\* moved since, PersistenceConflict makes prepare() start again from its
\* reads (github.ts:428-432), at most twice (admissionAttempt < 2); then the
\* exception leaves prepare() and the step becomes "uncertain".  Starting
\* again is one action: the failed put and the reads at github.ts:386-393
\* change nothing another request can see.
\* With ExpiryRetriesOnConflict = FALSE the conflict always leaves prepare().
HandoffLapsed ==
  /\ HandoffLapsedOn(eng)
  /\ IF eng.fresh
       THEN /\ IF eng.sIssued
                 THEN /\ setup' = "uncertain"
                      /\ UNCHANGED << expired, converted, created, refusedMoved >>
                      /\ Settle("app", "uncertain")
                 ELSE /\ expired' = FALSE /\ converted' = 0 /\ created' = "none"
                      /\ UNCHANGED setup
                      /\ Settle("app", "open")
            /\ ret' = StaleRets(ret) /\ rec' = StaleRec /\ page' = StalePage
       ELSE /\ UNCHANGED << setup, expired, converted, created, ret, rec, page, refusedMoved >>
            /\ IF ExpiryRetriesOnConflict /\ eng.tries < 2
                 THEN /\ eng' = [Start("app") EXCEPT !.tries = eng.tries + 1]
                      /\ UNCHANGED step
                 ELSE Settle("app", "uncertain")
  /\ UNCHANGED << run, issued, app, claim, local, instExpired, appArt,
                  instArt, token, haveRight, frozen, deadSeen, refusedMoved >>

\* Nothing to do but wait for you. github.ts:429-435 -> "awaiting-human"
StepStillWaiting ==
  /\ StepStillWaitingOn(eng)
  /\ Settle("app", "open")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* prepare() saw "converting" or "uncertain" and no app. github.ts:429-435 -> "uncertain"
StepMarkedUnclear ==
  /\ eng.node = "app" /\ eng.sApp = "none" /\ eng.sPhase \in {"converting", "uncertain"}
  /\ Settle("app", "uncertain")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* prepare() throws because the run was cancelled. github.ts:396-397, 439-440, 289-290
AppStepRefused ==
  /\ eng.node = "app"
  /\ \/ eng.sPhase = "cancelled"
     \/ eng.sPhase = "none" /\ eng.sApp = "none" /\ local # "none"
     \/ eng.sApp = "right" /\ SaveChecksCancelled /\ local = "cancelled"
  /\ Settle("app", "uncertain")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* --- step "inst": install(), github.ts:482-535 ---

\* Write the installation hand-off into the run's own record (or keep a
\* live one).  From here the run no longer points at the setup record.
InstallHandoffPrepared ==
  /\ InstallHandoffPreparedOn(eng)
  /\ IF local = "installation" /\ ~instExpired
       THEN UNCHANGED << local, instExpired, ret, refusedMoved >>
       ELSE local' = "installation" /\ instExpired' = FALSE /\ ret' = StaleInst(ret)
  /\ Settle("inst", "open")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, appArt,
                  instArt, token, page, rec, converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* The installation artifact exists: done, if the engine's verify accepts
\* it (checkInstallation again, github.ts:359-364). github.ts:490-495
InstallConfirmed ==
  /\ InstallConfirmedOn(eng)
  /\ Settle("inst", IF instArt = "good" THEN "complete" ELSE "uncertain")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* install() throws: the run was cancelled (github.ts:503-504), or GitHub
\* does not answer verifyApp (github.ts:489).
InstallStepRefused ==
  /\ eng.node = "inst"
  /\ \/ instArt = "none" /\ local = "cancelled"
     \/ "inst" \in GitHubFailsInSteps
  /\ Settle("inst", "uncertain")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* --- step "access": verifyAccess(), github.ts:934-990 ---

\* Check the recorded installation again (939-943), mint the token
\* (950-963), read the repositories, save the connection artifact (976).
TokenStored ==
  /\ TokenStoredOn(eng)
  /\ token' = instArt
  /\ Settle("access", "complete")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, ret, page, rec, converted,
                  created, haveRight, frozen, deadSeen, refusedMoved >>

\* verifyAccess() throws: installation rejected, run cancelled, or GitHub
\* does not answer.
AccessStepRefused ==
  /\ eng.node = "access"
  /\ \/ instArt # "good"
     \/ SaveChecksCancelled /\ local = "cancelled"
     \/ "access" \in GitHubFailsInSteps
  /\ Settle("access", "uncertain")
  /\ UNCHANGED << run, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

(***************************************************************************)
(* THE HAND-OFF PAGE "Continue at GitHub".  human(), github.ts:537-595,    *)
(* behind github-runtime.ts:1352-1389.  The route serves it only for an    *)
(* active run (github-runtime.ts:889-894).                                 *)
(***************************************************************************)
\* read(), the expiry check, then GET /users/{target}. github.ts:538-551
PageOpens ==
  /\ MayStart
  /\ run = "active" /\ page = "idle"
  /\ local = "shared" /\ setup = "registration" /\ ~expired
  /\ page' = "open"
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, ret, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* Mark handoffIssued and send the form that posts the manifest. github.ts:552-587
PageRenders ==
  /\ page = "open" /\ local = "shared" /\ setup = "registration"
  /\ issued' = TRUE /\ page' = "idle"
  /\ ret' = StaleRets(ret) /\ eng' = StaleEng /\ rec' = StaleRec
  /\ UNCHANGED << run, step, setup, expired, app, claim, local,
                  instExpired, appArt, instArt, token, converted, created, haveRight,
                  frozen, deadSeen, refusedMoved >>

\* The hand-off moved on meanwhile (github.ts:554-565), or GitHub did not answer.
PageFails ==
  /\ \/ page = "stale"
     \/ page = "open" /\ ~(local = "shared" /\ setup = "registration")
     \/ page = "open" /\ GitHubFailsInReturn
  /\ page' = "idle"
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, ret, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

(***************************************************************************)
(* GITHUB SENDS YOU BACK WITH A MANIFEST CODE.  callback(), registration   *)
(* branch, github.ts:637-728, behind github-runtime.ts:1321-1350.          *)
(***************************************************************************)
\* You created the app; the URL carries the current nonce, which only a
\* rendered page gave you.  read() and the checks at github.ts:638-649.
ReturnArrives(c) ==
  /\ MayStart
  /\ run = "active" /\ ret[c].pc = "idle"
  /\ local = "shared" /\ setup = "registration" /\ issued /\ ~expired
  /\ ret' = [ret EXCEPT ![c].pc = "regRead"]
  \* a second delivery of the same return carries the same app
  /\ \E a \in IF created # "none" THEN {created}
              ELSE IF WrongAccountPossible THEN {"right", "wrong"} ELSE {"right"} :
       /\ created' = a
       /\ haveRight' = (haveRight \/ a = "right")
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, page, rec,
                  converted, frozen, deadSeen, refusedMoved >>

\* One transaction claims the fence and consumes the nonce: phase
\* "converting", nonce "consumed", written with the revision that was read.
\* github.ts:661-679.  With AdmitComparesRevision = FALSE the put takes
\* whatever revision is there, and writes the phase it read over it.
ReturnAdmitted(c) ==
  /\ \/ ret[c].pc = "regRead"
     \/ ret[c].pc = "regStale" /\ ~AdmitComparesRevision
  /\ claim = {}
  /\ setup' = "converting" /\ claim' = {c}
  /\ app' = IF ret[c].pc = "regRead" THEN app ELSE "none"
  /\ ret' = [StaleRets(ret) EXCEPT ![c].pc = "admitted"]
  /\ eng' = StaleEng /\ rec' = StaleRec /\ page' = StalePage
  /\ UNCHANGED << run, step, issued, expired, local, instExpired, appArt,
                  instArt, token, converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* What the return route does after a refused return.  callback() throws
\* GitHubCallbackRefused and the route answers 409 without advancing the
\* run (github-runtime.ts:1324-1328).  With RefusalLeavesRun = FALSE the
\* route calls advance() (github-runtime.ts:1391-1405), whose first
\* transaction starts the first step not yet complete, as StepStarts does.
\* refusedMoved records that the refusal started the engine.
RefusalAnswered ==
  LET n == IF step.app # "complete" THEN "app"
           ELSE IF step.inst # "complete" THEN "inst" ELSE "access"
      starts == /\ ~RefusalLeavesRun
                /\ run = "active" /\ eng.node = "none"
                /\ \/ step[n] = "open"
                   \/ step[n] = "uncertain" /\ n \in RerunUncertain
  IN /\ eng' = IF starts THEN Start(n) ELSE eng
     /\ refusedMoved' = (refusedMoved \/ starts)

\* The claim is taken, or the record moved since it was read:
\* PersistenceConflict, which callback() turns into GitHubCallbackRefused.
\* github.ts:663-681
ReturnRefused(c) ==
  /\ \/ ret[c].pc = "regStale" /\ AdmitComparesRevision
     \/ ret[c].pc \in {"regRead", "regStale"} /\ claim # {}
  /\ ret' = [ret EXCEPT ![c].pc = "idle"]
  /\ RefusalAnswered
  /\ UNCHANGED << run, step, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, page, rec,
                  converted, created, haveRight, frozen, deadSeen >>

\* A return whose state is not the hand-off's current nonce arrives: the
\* same return again after another delivery consumed the nonce, or a return
\* from an earlier hand-off page.  The state check refuses it before
\* anything is written: read() and github.ts:638-647, or "already consumed"
\* at github.ts:729-730.  With the code as written this changes nothing,
\* so it is left out of Acts: it opens no way forward.
DuplicateReturnRefused(c) ==
  /\ MayStart
  /\ run = "active" /\ ret[c].pc = "idle"
  /\ local \in {"shared", "installation", "installed"}
  /\ RefusalAnswered
  /\ UNCHANGED << run, step, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen >>

\* What the catch block writes (github.ts:710-725): "uncertain", but only
\* while this return still holds the fence and nobody cancelled.
CatchWrites(c) ==
  IF claim = {c} /\ setup # "cancelled"
    THEN /\ setup' = "uncertain"
         /\ ret' = [StaleRets(ret) EXCEPT ![c].pc = "idle"]
         /\ eng' = StaleEng /\ rec' = StaleRec
    ELSE /\ ret' = [ret EXCEPT ![c].pc = "idle"]
         /\ UNCHANGED << setup, eng, rec, refusedMoved >>

\* POST /app-manifests/{code}/conversions answers with the app; it is kept
\* at once, under the fence. github.ts:681-698
ConversionSaved(c) ==
  /\ ret[c].pc = "admitted" /\ claim = {c}
  /\ converted' = converted + 1
  /\ app' = created /\ setup' = "converting"
  /\ ret' = [StaleRets(ret) EXCEPT ![c].pc = "saved"]
  /\ eng' = StaleEng /\ rec' = StaleRec
  /\ UNCHANGED << run, step, issued, expired, claim, local, instExpired,
                  appArt, instArt, token, page, created, haveRight, frozen, deadSeen, refusedMoved >>

\* The answer came but the fence is gone (cancelled, recovered, or 60 s
\* over): nothing is written. github.ts:691, 712-716
ConversionDropped(c) ==
  /\ ret[c].pc = "admitted" /\ claim # {c}
  /\ converted' = converted + 1
  /\ ret' = [ret EXCEPT ![c].pc = "idle"]
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, page, rec,
                  created, haveRight, frozen, deadSeen, refusedMoved >>

\* The conversion throws: no answer, or an answer that cannot be used. github.ts:710-725
ConversionFails(c) ==
  /\ GitHubFailsInReturn
  /\ ret[c].pc = "admitted"
  /\ converted' = converted + 1
  /\ CatchWrites(c)
  /\ UNCHANGED << run, step, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, page, created, haveRight, frozen,
                  deadSeen, refusedMoved >>

\* verifyApp passes; "app-ready" is written under the fence. github.ts:699-709
AppVerified(c) ==
  /\ ret[c].pc = "saved" /\ created = "right"
  /\ IF claim = {c} \/ ~AppReadyAssertsFence
       THEN /\ setup' = "app-ready"
            /\ ret' = [StaleRets(ret) EXCEPT ![c].pc = "idle"]
            /\ eng' = StaleEng /\ rec' = StaleRec
       ELSE /\ ret' = [ret EXCEPT ![c].pc = "idle"]
            /\ UNCHANGED << setup, eng, rec, refusedMoved >>
  /\ UNCHANGED << run, step, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, page, converted,
                  created, haveRight, frozen, deadSeen, refusedMoved >>

\* verifyApp throws after the app was kept: no answer, or the app belongs
\* to another account. github.ts:699, 710-725
AppVerifyFails(c) ==
  /\ GitHubFailsInReturn \/ created = "wrong"
  /\ ret[c].pc = "saved"
  /\ CatchWrites(c)
  /\ UNCHANGED << run, step, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, page, converted,
                  created, haveRight, frozen, deadSeen, refusedMoved >>

\* The process handling the return dies after the nonce was consumed.
ReturnDies(c) ==
  /\ RequestsDie
  /\ ret[c].pc \in {"admitted", "saved"}
  /\ ret' = [ret EXCEPT ![c].pc = "idle"]
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

(***************************************************************************)
(* GITHUB SENDS YOU BACK AFTER THE INSTALLATION.  callback(), installation *)
(* branch, github.ts:729-761, reached through the installation-return      *)
(* route (github.ts:70-99, github-runtime.ts:742-755).                     *)
(***************************************************************************)
\* The installation id in the URL is whatever the browser sends.
InstallReturnArrives(c, id) ==
  /\ MayStart
  /\ run = "active" /\ ret[c].pc = "idle"
  /\ local = "installation" /\ ~instExpired
  /\ ret' = [ret EXCEPT ![c] = [pc |-> "instRead", id |-> id]]
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* checkInstallation (730), then one transaction: phase "installed" with
\* the revision that was read, and the installation artifact. github.ts:739-761
InstallReturnRecorded(c) ==
  /\ ret[c].pc = "instRead"
  /\ ret[c].id = "good" \/ ~ReturnChecksInstallation
  /\ local' = "installed" /\ instArt' = ret[c].id
  /\ ret' = [StaleInst(ret) EXCEPT ![c] = RetIdle]
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  instExpired, appArt, token, page, rec, converted, created, haveRight,
                  frozen, deadSeen, refusedMoved >>

\* GitHub rejects the installation or does not answer, or the run's
\* record moved since it was read.
InstallReturnRefused(c) ==
  /\ \/ ret[c].pc = "instStale"
     \/ ret[c].pc = "instRead" /\ ret[c].id = "bad" /\ ReturnChecksInstallation
     \/ ret[c].pc = "instRead" /\ GitHubFailsInReturn
  /\ ret' = [ret EXCEPT ![c] = RetIdle]
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

(***************************************************************************)
(* THE RECOVERY PAGE.  github-runtime.ts:1074-1319.  Served only while     *)
(* step "app" is "uncertain" (1085-1086).                                  *)
(***************************************************************************)
\* You enter the app's id and private key.  recover() accepts only the
\* phases "uncertain" and "converting". github.ts:811-820
RecoveryStarts ==
  /\ MayStart
  /\ run = "active" /\ rec = "idle" /\ step.app = "uncertain" /\ haveRight
  /\ local = "shared" /\ setup \in {"uncertain", "converting"}
  /\ rec' = "read"
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, ret, page,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* GitHub confirms the app; one transaction cancels the fence and writes
\* "app-ready" with the revision that was read. github.ts:821-852
RecoveryStoresApp ==
  /\ rec = "read"
  /\ setup' = "app-ready" /\ app' = "right" /\ claim' = {}
  /\ rec' = "stored"
  /\ ret' = StaleRets(ret) /\ eng' = StaleEng
  /\ UNCHANGED << run, step, issued, expired, local, instExpired, appArt,
                  instArt, token, page, converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* The record moved since it was read, or GitHub did not confirm the app.
RecoveryFails ==
  /\ \/ rec = "stale"
     \/ rec = "read" /\ GitHubFailsInReturn
  /\ rec' = "idle"
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, ret, page,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* A second transaction lets the engine run step "app" again: node state
\* "uncertain" -> "verifying". github-runtime.ts:1191-1273
RecoveryReleasesStep ==
  /\ rec = "stored"
  /\ step' = IF run = "active" /\ step.app = "uncertain"
               THEN [step EXCEPT !.app = "open"] ELSE step
  /\ rec' = "idle"
  /\ UNCHANGED << run, eng, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, converted,
                  created, haveRight, frozen, deadSeen, refusedMoved >>

\* The process dies between those two transactions.
RecoveryDies ==
  /\ RequestsDie
  /\ rec = "stored"
  /\ rec' = "idle"
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, instExpired, appArt, instArt, token, ret, page,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* "Start a new registration": one transaction. restartRegistration()
\* (github.ts:771-808) needs phase "uncertain", no app and no live claim;
\* the same transaction releases step "app" (github-runtime.ts:1193-1273).
RegistrationRestarted ==
  /\ MayStart
  /\ run = "active" /\ step.app = "uncertain"
  /\ local = "shared" /\ setup = "uncertain" /\ app = "none" /\ claim = {}
  /\ setup' = "registration" /\ issued' = FALSE /\ expired' = FALSE
  /\ converted' = 0 /\ created' = "none"
  /\ step' = [step EXCEPT !.app = "open"]
  /\ ret' = StaleRets(ret) /\ eng' = StaleEng /\ rec' = StaleRec
  /\ page' = StalePage
  /\ UNCHANGED << run, app, claim, local, instExpired, appArt, instArt,
                  token, haveRight, frozen, deadSeen, refusedMoved >>

(***************************************************************************)
(* CANCEL.  Two transactions: the run (commands.ts:443-473), then the      *)
(* hand-off (github-runtime.ts:757-777 calling github.ts:856-900).         *)
(***************************************************************************)
YouCancel ==
  /\ run = "active" /\ step.access # "complete"
  /\ run' = "cancelled"
  /\ UNCHANGED << step, eng, setup, issued, expired, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, deadSeen, refusedMoved >>

\* The run's record becomes "cancelled".  While it still pointed at the
\* setup record and no other run subscribes, that record is cancelled too
\* and its fence is ended (github.ts:863-889).
CancelReachesHandoff ==
  /\ run = "cancelled" /\ local # "cancelled"
  /\ local' = "cancelled"
  /\ IF local = "shared"
       THEN /\ setup' = "cancelled" /\ claim' = {}
            /\ ret' = StaleInst(StaleRets(ret))
            /\ eng' = StaleEng /\ rec' = StaleRec /\ page' = StalePage
       ELSE /\ ret' = StaleInst(ret)
            /\ UNCHANGED << setup, claim, eng, rec, page, refusedMoved >>
  /\ frozen' = << local', appArt, instArt, token, setup' = "cancelled",
                  IF setup' = "cancelled" THEN app ELSE "none" >>
  /\ UNCHANGED << run, step, issued, expired, app, instExpired, appArt,
                  instArt, token, converted, created, haveRight, deadSeen, refusedMoved >>

(***************************************************************************)
(* What can still change something while the run is active: every action   *)
(* above except Cancel, with an "uncertain" step's rerun counted only when *)
(* it can end differently (RerunMoves).  A dead end is a state where none  *)
(* of them is possible.                                                    *)
(***************************************************************************)
StepMoves(n) == StepStarts(n) /\ (step[n] = "open" \/ RerunMoves(n))

Acts ==
  \/ \E n \in Steps : StepMoves(n)
  \/ HandoffPrepared \/ AppConfirmed \/ AppCheckUnanswered \/ HandoffLapsed
  \/ StepStillWaiting \/ StepMarkedUnclear \/ AppStepRefused
  \/ InstallHandoffPrepared \/ InstallConfirmed \/ InstallStepRefused
  \/ TokenStored \/ AccessStepRefused
  \/ PageOpens \/ PageRenders \/ PageFails
  \/ \E c \in Returns :
       \/ ReturnArrives(c) \/ ReturnAdmitted(c) \/ ReturnRefused(c)
       \/ ConversionSaved(c) \/ ConversionDropped(c) \/ ConversionFails(c)
       \/ AppVerified(c) \/ AppVerifyFails(c) \/ ReturnDies(c)
       \/ \E id \in {"good", "bad"} : InstallReturnArrives(c, id)
       \/ InstallReturnRecorded(c) \/ InstallReturnRefused(c)
  \/ RecoveryStarts \/ RecoveryStoresApp \/ RecoveryFails
  \/ RecoveryReleasesStep \/ RecoveryDies \/ RegistrationRestarted

Open == run = "active" /\ step.access # "complete"

\* One timer opens a way forward: "Start a new registration" claims the
\* setup key (github.ts:790-794) and is refused while a return's 60-second
\* claim is still live; once it lapses the restart goes through.
WaitThenRestart ==
  /\ claim # {}
  /\ step.app = "uncertain" /\ local = "shared" /\ setup = "uncertain" /\ app = "none"

DeadEnd == Open /\ ~ENABLED Acts /\ ~WaitThenRestart

(***************************************************************************)
(* TIMERS.  They only run while the run is active; afterwards nothing      *)
(* reads them.                                                             *)
(***************************************************************************)
\* expires = now + 3600000, github.ts:423, 459, 802
HandoffExpires ==
  /\ MayStart
  /\ run = "active" /\ local = "shared" /\ setup = "registration" /\ ~expired
  /\ expired' = TRUE
  /\ deadSeen' = (deadSeen \/ DeadEnd)
  /\ UNCHANGED << run, step, eng, setup, issued, app, claim, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, refusedMoved >>

\* github.ts:511
InstallHandoffExpires ==
  /\ MayStart
  /\ run = "active" /\ local = "installation" /\ ~instExpired
  /\ instExpired' = TRUE
  /\ deadSeen' = (deadSeen \/ DeadEnd)
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, claim,
                  local, appArt, instArt, token, ret, page, rec, converted,
                  created, haveRight, frozen, refusedMoved >>

\* The return's claim lasts 60 s and is never released by the return
\* itself (github.ts:665-669; persistence/index.ts:399-440).
ClaimLapses ==
  /\ MayStart
  /\ run = "active" /\ claim # {}
  /\ claim' = {}
  /\ deadSeen' = (deadSeen \/ DeadEnd)
  /\ UNCHANGED << run, step, eng, setup, issued, expired, app, local,
                  instExpired, appArt, instArt, token, ret, page, rec,
                  converted, created, haveRight, frozen, refusedMoved >>

\* Connected, or cancelled with nothing left in flight: the end.
Done ==
  /\ \/ step.access = "complete"
     \/ local = "cancelled"
  /\ ~ENABLED Acts
  /\ UNCHANGED vars

\* Next lists the actions of Acts again, so that TLC names each step.  Keep
\* the two lists the same.  DuplicateReturnRefused is in Next only (see
\* there).
Next ==
  \/ \E n \in Steps : StepStarts(n)
  \/ HandoffPrepared \/ AppConfirmed \/ AppCheckUnanswered \/ HandoffLapsed
  \/ StepStillWaiting \/ StepMarkedUnclear \/ AppStepRefused
  \/ InstallHandoffPrepared \/ InstallConfirmed \/ InstallStepRefused
  \/ TokenStored \/ AccessStepRefused
  \/ PageOpens \/ PageRenders \/ PageFails
  \/ \E c \in Returns :
       \/ ReturnArrives(c) \/ ReturnAdmitted(c) \/ ReturnRefused(c)
       \/ ConversionSaved(c) \/ ConversionDropped(c) \/ ConversionFails(c)
       \/ AppVerified(c) \/ AppVerifyFails(c) \/ ReturnDies(c)
       \/ \E id \in {"good", "bad"} : InstallReturnArrives(c, id)
       \/ InstallReturnRecorded(c) \/ InstallReturnRefused(c)
       \/ DuplicateReturnRefused(c)
  \/ RecoveryStarts \/ RecoveryStoresApp \/ RecoveryFails
  \/ RecoveryReleasesStep \/ RecoveryDies \/ RegistrationRestarted
  \/ YouCancel \/ CancelReachesHandoff
  \/ HandoffExpires \/ InstallHandoffExpires \/ ClaimLapses
  \/ Done

Spec == Init /\ [][Next]_vars

Symmetry == Permutations(Returns)

(***************************************************************************)
(* THE RULES                                                               *)
(***************************************************************************)

\* The one-time manifest code of a hand-off is sent to GitHub at most once.
ConvertedAtMostOnce == converted <= 1

\* After the hand-off is cancelled nothing more is recorded: no phase
\* change, no app, no installation, no token.
CancelledStaysCancelled == local = "cancelled" => Recorded = frozen

\* The installation that is recorded, and that the token is minted for, is
\* one GitHub confirmed for this app and this account.
InstallationCheckedBeforeToken ==
  /\ instArt # "bad"
  /\ token # "none" => instArt = "good" /\ token = "good"

\* A refused return writes nothing and proves nothing about the hand-off,
\* so it does not make the engine run a step: the run stays as it was.
RefusedReturnLeavesRun == ~refusedMoved

\* "Start a new registration" is offered as soon as a return has failed:
\* once the return that wrote "uncertain" has ended, no claim of it is left
\* on the setup key for the restart to wait out.  No timer is needed to
\* reach a restart.
RestartWithoutWaiting ==
  ~( /\ claim # {} /\ \A c \in claim : ret[c].pc = "idle"
     /\ local = "shared" /\ setup = "uncertain" )

\* Once the run's cancel has committed (YouCancel, the first of the two
\* cancel transactions), nothing more is stored: no app in the setup record,
\* no app, installation or connection artifact.  CancelledStaysCancelled
\* speaks only about the time after the second transaction; this rule
\* closes the window between the two.  An action property.
NothingStoredAfterCancel ==
  [][run = "cancelled" => UNCHANGED << app, appArt, instArt, token >>]_vars

\* While the run is active and not yet connected, something other than
\* Cancel can still change it.
NoDeadEnd == ~DeadEnd

\* NoDeadEnd does not hold.  Its four parts, one per finding in README.md,
\* name the dead ends the code had; parts 1 to 3 hold since every step runs
\* again from "uncertain" (github.ts:348), and part 4 does not:
\*   1. the app is stored, but step "app" is "uncertain" and recover() refuses
\*      the phase "app-ready" (github.ts:819-820)
AppReadyNeverStranded ==
  ~(DeadEnd /\ step.app = "uncertain" /\ local = "shared" /\ setup = "app-ready")
\*   2. the hand-off expired, but step "app" is "uncertain" and only prepare()
\*      moves the phase "registration" on (github.ts:409-428)
ExpiredHandoffNeverStranded ==
  ~(DeadEnd /\ step.app = "uncertain" /\ local = "shared" /\ setup = "registration")
\* The step that finds the hand-off's hour over moves the hand-off on
\* (github.ts:409-436), even when the record moved since prepare() read it:
\* step "app" never settles "uncertain" while the hand-off is still an
\* expired "registration".  A rerun of the step may move it on later; this
\* rule asks that the step which found the expiry does not leave it to one.
\* An action property: it speaks about the step in which "app" settles.
ExpiryWrittenByTheStep ==
  [][ ( /\ eng.node = "app" /\ eng.sPhase = "registration" /\ eng.sApp = "none"
        /\ eng'.node = "none"
        /\ local = "shared" /\ setup = "registration" /\ expired
        /\ step'.app = "uncertain" )
      => ~(setup' = "registration" /\ expired') ]_vars
\*   3. step "inst" or "access" is "uncertain"; the recovery page serves only
\*      step "app" (github-runtime.ts:1074-1087)
LaterStepsNeverStranded ==
  ~(DeadEnd /\ (step.inst = "uncertain" \/ step.access = "uncertain"))
\*   4. the app was created under another account: it can never be
\*      confirmed, so running the app step again only throws again, you have
\*      no other app to enter, and restartRegistration() refuses because an
\*      app is stored or the phase is still "converting" (github.ts:785-789)
WrongAccountNeverStranded ==
  ~(DeadEnd /\ step.app = "uncertain" /\ local = "shared"
            /\ setup \in {"uncertain", "converting"})

\* Checked by the normal configuration, with parts 1 to 3: there is no dead
\* end of any other shape than part 4.  Together with the four parts above
\* this is NoDeadEnd.
OnlyKnownDeadEnds ==
  DeadEnd => \/ step.app = "uncertain" /\ local = "shared"
                  /\ setup \in {"uncertain", "converting"}
                  /\ created = "wrong" /\ ~haveRight

\* Counting no timer but the one in WaitThenRestart is fair: once in a dead
\* end, no timer running out makes anything possible again.  It is read
\* while the engine is idle: from a dead end the engine may still start a
\* rerun that cannot move (RerunMoves), and that rerun's own outcome is
\* possible until it settles back where it started.
TimersNeverRescue == deadSeen /\ eng.node = "none" => ~(Open /\ ENABLED Acts)

=============================================================================
