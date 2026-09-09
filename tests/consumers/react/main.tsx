import React, {
  StrictMode,
  type CSSProperties,
  type ButtonHTMLAttributes,
} from "react";
import { createRoot } from "react-dom/client";
import { Ceremony, createHttpTransport } from "@ceremony/auth/react";
import { manifestSchema } from "@ceremony/auth";
import "@ceremony/auth/styles.css";

const config = await fetch("/api/config").then((response) => response.json());
const manifest = manifestSchema.parse(config.manifests[1]);
const transport = createHttpTransport();
const theme = {
  "--ceremony-bg": "#182b24",
  "--ceremony-fg": "#eef5ef",
  "--ceremony-muted": "#b9cabe",
  "--ceremony-border": "#809d8a",
  "--ceremony-accent": "#b4e2c4",
  "--ceremony-on-accent": "#182b24",
  "--ceremony-focus": "#b4e2c4",
  "--ceremony-radius": "0.25rem",
  padding: "1rem",
} satisfies CSSProperties & Record<string, string>;
function HostButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="host-button" />;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <section id="light">
      <Ceremony
        manifest={manifest}
        transport={transport}
        autoFocus={false}
        aria-label="Personal Stripe connection"
        webmcp={{ prefix: "external_light" }}
      />
    </section>
    <section id="dark">
      <Ceremony
        manifest={manifest}
        transport={transport}
        autoFocus={false}
        style={theme}
        aria-label="Team Stripe connection"
        dir="rtl"
        webmcp={{ prefix: "external_dark" }}
      />
    </section>
    <section id="custom">
      <h2>Host UI library</h2>
      <Ceremony
        manifest={manifest}
        transport={transport}
        webmcp={{ prefix: "external_custom" }}
      >
        {({ snapshot, busy, error, execute }) => (
          <>
            {error && <p role="alert">{error}</p>}
            {snapshot?.step === "complete" ? (
              <p>Custom connected</p>
            ) : snapshot?.actions.includes("submit") ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const token = new FormData(event.currentTarget).get("token");
                  event.currentTarget.reset();
                  if (typeof token === "string")
                    void execute({ action: "submit", values: { token } }).catch(
                      () => {},
                    );
                }}
              >
                <label htmlFor="custom-token">Host token</label>
                <input
                  id="custom-token"
                  name="token"
                  type="password"
                  required
                  disabled={busy}
                />
                <HostButton type="submit" disabled={busy}>
                  Connect from host
                </HostButton>
              </form>
            ) : (
              <p>Loading ceremony</p>
            )}
          </>
        )}
      </Ceremony>
    </section>
  </StrictMode>,
);
