// The chart of CeremonySteps.tla, in the words of the person who connects a service.
// Used with Chart.cfg; see the README for which steps it hides.

export const title = "Connecting a service: the screens you see and what moves them";

const anonymousKept = (v) => v.own === "anonymous";
// A result on screen that the adapter serving this attempt never obtained.
const leftOver = (v) => v.own !== "none" && !v.holds;

export const state = (v) => {
  if (leftOver(v)) return "The access you cancelled is back on screen";
  switch (v.step) {
    case "intro":
      return ["Connecting", "Start screen"];
    case "input":
      // The form flow's second round, where the provider asks for a code it sent, stays on this screen.
      return ["Connecting", "Enter your key, password or code"];
    case "redirect":
      return ["Connecting", "Sign in at the provider"];
    case "waiting":
      return v.kind === "authmd-anonymous"
        ? "Claiming it for your account"
        : ["Connecting", "Approve with the code shown"];
    case "claim":
      return "Claiming it for your account";
    case "anonymous":
      return "You have anonymous access";
    case "complete":
      return "Connected";
    case "cancelled":
      return ["Not connected", "Cancelled"];
    case "expired":
      return anonymousKept(v) ? "You have anonymous access" : ["Not connected", "Expired"];
    case "error":
      return anonymousKept(v) ? "You have anonymous access" : ["Not connected", "Something went wrong"];
  }
};

export const step = (action, from, to) => {
  const stoppedScreen = ["error", "expired"].includes(from.step) && !anonymousKept(from) && !leftOver(from);
  switch (action) {
    case "ActBegin":
      return "you press start";
    case "BeginReturns":
      if (from.kind === "oauth-code") return "you start [to sign in at the provider]";
      if (from.kind === "device") return "you start [with a device code]";
      if (from.kind === "authmd-anonymous") return "you start [anonymous access]";
      return "you start";
    case "ActSubmit":
      return "you send what you entered";
    case "SubmitReturnsComplete":
      return "the provider accepts what you entered";
    case "SubmitReturnsCodeInput":
      return "the provider sends you a code to enter";
    case "SubmitReturnsWaiting":
      return "the provider asks you to approve the claim";
    case "Callback":
      return to.step === "error" ? "the provider refuses or fails" : "the provider sends you back";
    case "CallbackReturns":
      return "the provider sends you back";
    case "ReadPolls":
      return "the page asks the provider";
    case "PollReturnsNothing":
      return "the provider says not yet";
    case "PollReturnsComplete":
      return from.kind === "authmd-anonymous" ? "the provider confirms your claim" : "you approve at the provider";
    case "BeginThrows":
    case "SubmitThrows":
    case "CallbackThrows":
    case "PollThrowsCeremonyError":
    case "PollThrowsOther":
      return anonymousKept(from) ? "the claim fails" : "the provider refuses or fails";
    case "ActClaim":
      return from.step === "complete" ? "you choose to claim it [if your access is still anonymous]" : "you choose to claim it";
    case "ActFinish":
      return "you finish";
    case "ActRetry":
      return leftOver(to) ? "you try again [after cancelling anonymous access]" : "you try again";
    case "ActCancel":
      // Hidden: cancel on the expired and error screens, which only swaps one stopped screen for another.
      return stoppedScreen ? null : "you cancel";
    case "ExpireOnAccess":
      // Hidden: the error screen expiring.
      return stoppedScreen ? null : "time runs out";
    case "DeadlinePasses":
      return "the deadline passes";
    case "ActRequestHuman":
      return "you ask for a person to help";
    case "RequestHumanReturns":
      return "the request for help is answered";
    case "RequestHumanThrows":
      return "the request for help fails";
    case "TabRefreshes":
      return "you look at the page again";
    case "Done":
      return "nothing more happens";
  }
  return action;
};

export const group = (v) => {
  if (leftOver(v)) return undefined;
  if (v.step === "complete") return "Connected";
  if (v.own === "anonymous" && v.step !== "cancelled") return "Anonymous access";
  if (["cancelled", "expired", "error"].includes(v.step)) return "Not connected";
  return "Connecting";
};

export const colors = {
  Connecting: "blue",
  "Anonymous access": "purple",
  Connected: "teal",
  "Not connected": "tan",
};
