import { useEffect, useState } from "react";

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** Installation is optional. No authorization state is persisted by this module. */
export function usePwaInstall() {
  const [prompt, setPrompt] = useState<InstallPrompt>();
  const [waiting, setWaiting] = useState<ServiceWorker>();
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let active = true;
    const install = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const done = () => {
      setPrompt(undefined);
      setInstalled(true);
    };
    addEventListener("beforeinstallprompt", install);
    addEventListener("appinstalled", done);
    setInstalled(matchMedia("(display-mode: standalone)").matches);
    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => {
          if (!active) return;
          if (registration.waiting) setWaiting(registration.waiting);
          registration.addEventListener("updatefound", () => {
            registration.installing?.addEventListener("statechange", () => {
              if (
                active &&
                registration.waiting &&
                navigator.serviceWorker.controller
              )
                setWaiting(registration.waiting);
            });
          });
        })
        .catch(() => {
          /* Normal connection does not depend on service-worker support. */
        });
    }
    return () => {
      active = false;
      removeEventListener("beforeinstallprompt", install);
      removeEventListener("appinstalled", done);
    };
  }, []);
  return {
    canInstall: !!prompt && !installed,
    installed,
    updateAvailable: !!waiting,
    async install() {
      if (!prompt) return;
      await prompt.prompt();
      await prompt.userChoice;
      setPrompt(undefined);
    },
    update() {
      if (!waiting) return;
      waiting.postMessage({ type: "activate-static-update" });
      setWaiting(undefined);
    },
    instructions: installed
      ? "Installed. Connections remain tied to your signed-in account."
      : /iPad|iPhone|iPod/.test(navigator.userAgent)
        ? "In Safari, use Share, then Add to Home Screen. Installation is optional."
        : "Use your browser’s install option if available. Installation is optional.",
  };
}
