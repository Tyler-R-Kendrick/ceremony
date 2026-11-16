---- MODULE ConnectGitHub ----
(* The GitHub App ceremony of src/kernel/flows/github-app.ts as the person
   connecting meets it. Each variable is a fact of that declaration; each
   action is an operator outcome or something the world does. Ceremony's own
   choice of what to do next is the planner's: look at what holds, do only
   what is missing. *)
VARIABLES target, code, app, installation, token, screen, ended

vars == <<target, code, app, installation, token, screen, ended>>

Running == ended = "running"
Idle == Running /\ screen = "none"

Init ==
  /\ target = FALSE /\ code = FALSE /\ app = FALSE
  /\ installation = FALSE /\ token = FALSE
  /\ screen = "none" /\ ended = "running"

(* chooseTarget *)
CeremonyAsksWhichAccount ==
  /\ Idle /\ ~target
  /\ screen' = "account"
  /\ UNCHANGED <<target, code, app, installation, token, ended>>

YouNameTheAccount ==
  /\ Running /\ screen = "account"
  /\ target' = TRUE /\ screen' = "none"
  /\ UNCHANGED <<code, app, installation, token, ended>>

(* registerApp *)
CeremonyAsksYouToCreateTheApp ==
  /\ Idle /\ target /\ ~app /\ ~code
  /\ screen' = "create"
  /\ UNCHANGED <<target, code, app, installation, token, ended>>

YouCreateTheAppOnGitHub ==
  /\ Running /\ screen = "create"
  /\ code' = TRUE /\ screen' = "none"
  /\ UNCHANGED <<target, app, installation, token, ended>>

YouCannotCreateAppsHere ==
  /\ Running /\ screen = "create"
  /\ ended' = "no way left to an app" /\ screen' = "none"
  /\ UNCHANGED <<target, code, app, installation, token>>

(* convertManifest *)
CeremonyTradesTheCodeForTheApp ==
  /\ Idle /\ target /\ code /\ ~app
  /\ app' = TRUE /\ code' = FALSE
  /\ UNCHANGED <<target, installation, token, screen, ended>>

GitHubRejectsTheCode ==
  /\ Idle /\ target /\ code /\ ~app
  /\ code' = FALSE
  /\ UNCHANGED <<target, app, installation, token, screen, ended>>

(* installApp *)
CeremonyAsksYouToInstall ==
  /\ Idle /\ app /\ ~installation
  /\ screen' = "install"
  /\ UNCHANGED <<target, code, app, installation, token, ended>>

YouInstallTheApp ==
  /\ Running /\ screen = "install" /\ app
  /\ installation' = TRUE /\ screen' = "none"
  /\ UNCHANGED <<target, code, app, token, ended>>

GitHubNoLongerKnowsTheApp ==
  /\ Running /\ screen = "install" /\ ~app
  /\ screen' = "none"
  /\ UNCHANGED <<target, code, app, installation, token, ended>>

AnOwnerMustApproveFirst ==
  /\ Running /\ screen = "install" /\ app
  /\ ended' = "waiting for an owner's approval" /\ screen' = "none"
  /\ UNCHANGED <<target, code, app, installation, token>>

(* mintToken *)
CeremonyMintsTheToken ==
  /\ Idle /\ installation /\ ~token
  /\ token' = TRUE
  /\ UNCHANGED <<target, code, app, installation, screen, ended>>

CeremonyFinishes ==
  /\ Idle /\ token
  /\ ended' = "connected"
  /\ UNCHANGED <<target, code, app, installation, token, screen>>

YouSayNotNow ==
  /\ Running /\ screen # "none"
  /\ ended' = "declined" /\ screen' = "none"
  /\ UNCHANGED <<target, code, app, installation, token>>

(* What the world does while the run is open. *)
TheAppIsDeleted ==
  /\ Running /\ app
  /\ app' = FALSE /\ installation' = FALSE /\ token' = FALSE
  /\ UNCHANGED <<target, code, screen, ended>>

TheInstallationIsRemoved ==
  /\ Running /\ installation
  /\ installation' = FALSE /\ token' = FALSE
  /\ UNCHANGED <<target, code, app, screen, ended>>

Done == ~Running /\ UNCHANGED vars

Next ==
  \/ CeremonyAsksWhichAccount \/ YouNameTheAccount
  \/ CeremonyAsksYouToCreateTheApp \/ YouCreateTheAppOnGitHub
  \/ YouCannotCreateAppsHere
  \/ CeremonyTradesTheCodeForTheApp \/ GitHubRejectsTheCode
  \/ CeremonyAsksYouToInstall \/ YouInstallTheApp
  \/ GitHubNoLongerKnowsTheApp \/ AnOwnerMustApproveFirst
  \/ CeremonyMintsTheToken \/ CeremonyFinishes \/ YouSayNotNow
  \/ TheAppIsDeleted \/ TheInstallationIsRemoved
  \/ Done

(* The rules. *)
ATokenRestsOnAnInstallation == token => installation
AnInstallationRestsOnTheApp == installation => app
TheAppRestsOnAChosenAccount == app => target
ConnectedMeansATokenIsHeld == ended = "connected" => token
OneQuestionAtATime == screen # "none" => Running
NothingIsAskedTwice ==
  /\ screen = "account" => ~target
  /\ screen = "install" => ~installation
====
