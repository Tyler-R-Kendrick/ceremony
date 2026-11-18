// View for the /statechart skill: draws GitHubHandoff.tla with Chart.cfg as
// the "Connect GitHub" flow in the words of the person connecting.

const CONNECTING = "Connecting GitHub";
const START = "Not started";
const CREATE = "Waiting for you to create the app on GitHub";
const FETCH = "Ceremony is fetching your new app from GitHub";
const UNSURE = "Ceremony is unsure whether your app exists";
const APP = "App ready";
const APP_UNCLEAR = "App ready, but the app step did not finish";
const INSTALL = "Waiting for you to install the app on GitHub";
const INSTALLED = "App installed";
const CONNECTED = "Connected: token stored";
const CANCELLED = "Cancelled";
const STUCK = "Stuck: only Cancel is left";

const returning = (v) =>
  Object.values(v.ret).some((r) => ["regRead", "regStale", "admitted", "saved"].includes(r.pc));

const inFlight = (v) =>
  v.eng.node !== "none" ||
  v.page !== "idle" ||
  v.rec !== "idle" ||
  Object.values(v.ret).some((r) => r.pc !== "idle");

// The states the rule NoDeadEnd marks: a step is marked unclear and nothing
// but Cancel, or running the step again only to fail again, can change
// anything any more.  Every step runs again from "uncertain", so the one
// such state is an app of another account that Ceremony holds while it
// will not let you register again.
const stuck = (v) => {
  if (inFlight(v)) return false;
  if (v.step.app !== "uncertain" || v.local !== "shared") return false;
  if (!["uncertain", "converting"].includes(v.setup)) return false;
  const mayRestart = v.setup === "uncertain" && v.app === "none";
  return v.created === "wrong" && !v.haveRight && !mayRestart;
};

// One label per situation you can be in.
const label = (v) => {
  if (v.run === "cancelled" || v.local === "cancelled") return CANCELLED;
  if (v.step.access === "complete") return CONNECTED;
  if (stuck(v)) return STUCK;
  if (v.local === "installed") return INSTALLED;
  if (v.local === "installation") return INSTALL;
  if (v.local === "none") return START;
  if (returning(v)) return FETCH;
  if (v.step.app === "uncertain" && v.setup === "app-ready" && !inFlight(v))
    return APP_UNCLEAR;
  if (v.step.app === "complete" || v.setup === "app-ready") return APP;
  if (v.setup === "uncertain" || v.setup === "converting") return UNSURE;
  // Still "registration": once the page was shown and the hour is over,
  // nobody knows whether you created the app.
  return v.expired && v.issued ? UNSURE : CREATE;
};

// Everything before the end sits in one parent state, so that "you cancel",
// which is possible in each of them, is drawn as one arrow.
export const state = (v) => {
  const l = label(v);
  return l === CANCELLED || l === CONNECTED ? [l] : [CONNECTING, l];
};

const stepNames = { app: "app step", inst: "install step", access: "token step" };

export const step = (action, from, to) => {
  switch (action) {
    // the run's steps
    case "StepStarts":
      return from.step[to.eng.node] === "uncertain"
        ? `Ceremony runs the ${stepNames[to.eng.node]} again`
        : `Ceremony starts the ${stepNames[to.eng.node]}`;
    case "HandoffPrepared":
      return "Ceremony prepares the GitHub hand-off";
    case "StepStillWaiting":
      return "Ceremony finds it is still waiting for you";
    case "HandoffLapsed":
      return "Ceremony finds the hand-off expired";
    case "StepMarkedUnclear":
      return "Ceremony marks the app step unclear";
    case "AppConfirmed":
      return "Ceremony confirms the app with GitHub [when it already holds the app]";
    case "AppCheckUnanswered":
      return from.eng.sApp === "wrong"
        ? "GitHub again does not confirm the app for the account you chose"
        : "GitHub does not answer when Ceremony checks the app";
    case "InstallHandoffPrepared":
      return "Ceremony prepares the install hand-off";
    case "InstallConfirmed":
      return "Ceremony confirms the installation";
    case "TokenStored":
      return "Ceremony checks the installation and stores a token";
    case "AppStepRefused":
      return "Ceremony stops the step you cancelled";
    case "InstallStepRefused":
      return from.local === "cancelled"
        ? "Ceremony stops the step you cancelled"
        : "GitHub does not answer during the install step";
    case "AccessStepRefused":
      return from.local === "cancelled"
        ? "Ceremony stops the step you cancelled"
        : from.instArt === "bad"
          ? "GitHub rejects the installation"
          : "GitHub does not answer during the token step";

    // the hand-off page
    case "PageOpens":
      return "you open the hand-off page";
    case "PageRenders":
      return "the page sends you to GitHub";
    case "PageFails":
      return "the hand-off page fails";

    // GitHub sends you back after you created the app
    case "ReturnArrives":
      return to.created === "wrong"
        ? "you create the app under another GitHub account and GitHub sends you back"
        : "you create the app on GitHub and GitHub sends you back";
    case "ReturnAdmitted":
      return "Ceremony uses up the one-time return link";
    case "ReturnRefused":
      return "Ceremony refuses the return";
    case "ConversionSaved":
      return "GitHub hands over the app and Ceremony stores it";
    case "ConversionDropped":
      return "GitHub hands over the app too late to store it";
    case "AppVerified":
      return "GitHub confirms the app";
    case "ConversionFails":
      return "GitHub does not answer";
    case "AppVerifyFails":
      return from.created === "wrong"
        ? "GitHub does not confirm the app for the account you chose"
        : "GitHub does not answer";
    case "ReturnDies":
    case "RecoveryDies":
      return "Ceremony's process dies";

    // GitHub sends you back after you installed the app
    case "InstallReturnArrives":
      return Object.values(to.ret).some((r) => r.id === "bad")
        ? "a return arrives with an installation GitHub would reject"
        : "GitHub sends you back from the installation";
    case "InstallReturnRecorded":
      return to.instArt === "bad"
        ? "Ceremony records the installation without asking GitHub"
        : "you install the app and GitHub sends you back";
    case "InstallReturnRefused":
      return "Ceremony refuses the installation";

    // the recovery page
    case "RecoveryStarts":
      return "you open the recovery page";
    case "RecoveryStoresApp":
      return "you enter the app's ID and private key on the recovery page";
    case "RecoveryFails":
      return "the recovery fails";
    case "RecoveryReleasesStep":
      return "Ceremony lets the app step run again";
    case "RegistrationRestarted":
      return "you start a new registration [when Ceremony holds no app]";

    // timers
    case "HandoffExpires":
      return from.issued
        ? "the hand-off expires [after you opened the GitHub page]"
        : "the hand-off expires [before you opened the GitHub page]";
    case "InstallHandoffExpires":
      return "the install hand-off expires";
    case "ClaimLapses":
      return "60 seconds pass";

    // cancel
    case "YouCancel":
      return "you cancel";
    case "CancelReachesHandoff":
      return "Ceremony cancels the hand-off";
    default:
      return "nothing more happens";
  }
};

export const group = (v) => {
  const l = label(v);
  if (l === STUCK) return "Stuck";
  if (l === CANCELLED) return "Cancelled";
  if (l === CONNECTED) return "Connected";
  if ([START, CREATE, FETCH, UNSURE].includes(l)) return "Create the app";
  return "Install the app";
};

export const colors = {
  "Create the app": "blue",
  "Install the app": "purple",
  Connected: "teal",
  Cancelled: "tan",
  Stuck: "orange",
};

export const title = "Connect GitHub, one run: create the app, install it, get a token";
