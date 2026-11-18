export const title = "Connect GitHub through a GitHub App";

export const state = (v) => {
  if (v.ended !== "running") {
    return v.ended === "connected"
      ? "Connected"
      : v.ended === "declined"
        ? "Stopped: you said not now"
        : v.ended === "no way left to an app"
          ? "Stopped: no way left to an app"
          : "Stopped: waiting for an owner's approval";
  }
  if (v.screen === "account") return "Asked which account";
  if (v.screen === "create") return "Asked to create the app";
  if (v.screen === "install") return "Asked to install the app";
  if (v.token) return "Token in hand";
  if (v.installation) return "App installed";
  if (v.app) return "Holding the app";
  if (v.code) return "Back from GitHub with a code";
  if (v.target) return "Account chosen";
  return "Nothing yet";
};

export const group = (v) =>
  v.ended !== "running"
    ? v.ended === "connected"
      ? "done"
      : "stopped"
    : v.screen !== "none"
      ? "you"
      : "ceremony";

export const colors = { you: "blue", ceremony: "teal", done: "purple", stopped: "tan" };

const labels = {
  CeremonyAsksWhichAccount: "Ceremony asks which account",
  YouNameTheAccount: "you name the account",
  CeremonyAsksYouToCreateTheApp: "Ceremony asks you to create the app",
  YouCreateTheAppOnGitHub: "you create the app on GitHub",
  YouCannotCreateAppsHere: "you can't create apps here",
  CeremonyTradesTheCodeForTheApp: "Ceremony trades the code for the app",
  GitHubRejectsTheCode: "GitHub rejects the code",
  CeremonyAsksYouToInstall: "Ceremony asks you to install",
  YouInstallTheApp: "you install the app",
  GitHubNoLongerKnowsTheApp: "GitHub no longer knows the app",
  AnOwnerMustApproveFirst: "an owner must approve first",
  CeremonyMintsTheToken: "Ceremony mints the token",
  CeremonyFinishes: "Ceremony finishes",
  YouSayNotNow: "you say not now",
  TheAppIsDeleted: "the app is deleted",
  TheInstallationIsRemoved: "the installation is removed",
};

export const step = (action) => labels[action] ?? null;
