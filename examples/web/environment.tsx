import { useEffect, useState } from "react";
import { z } from "zod";

const metadataSchema = z.object({
  revision: z.number().int(),
  names: z.array(z.string()),
});
function Variables() {
  const [metadata, setMetadata] = useState<z.infer<typeof metadataSchema>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const endpoint = "/api/environment";
  useEffect(() => {
    let current = true;
    void fetch(endpoint)
      .then(async (response) => {
        if (!response.ok) throw Error();
        const result = metadataSchema.parse(await response.json());
        if (current) setMetadata(result);
      })
      .catch(() => {
        if (current) {
          setFailed(true);
          setMessage(
            "Could not load environment. Reopen this section to retry.",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [endpoint]);
  async function save(edit: {
    values?: Record<string, string>;
    remove?: string[];
    dotenv?: string;
  }) {
    if (!metadata || busy) return false;
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: metadata.revision, ...edit }),
      });
      if (!response.ok)
        throw Error(
          response.status === 409
            ? "Environment changed. Reopen this section before saving again."
            : "Could not save. Check variable names and the 64 KB limit.",
        );
      setMetadata(metadataSchema.parse(await response.json()));
      setMessage(
        "Environment saved. Values remain private. Changes apply when setup next begins, not to already configured attempts.",
      );
      return true;
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error ? error.message : "Could not save environment.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="environment-editor" aria-label="Session environment">
      <h2>Session variables</h2>
      <p>
        Import a .env file or save individual values. Matching names are
        replaced; saved values stay private.
      </p>
      <details>
        <summary>Supported GitHub App variables</summary>
        <p>
          Live GitHub App setup reads <code>GITHUB_APP_ID</code>,{" "}
          <code>GITHUB_APP_SLUG</code>, <code>GITHUB_APP_OWNER</code> and{" "}
          <code>GITHUB_APP_PRIVATE_KEY</code>. Supply all four to reuse an app.
          Otherwise leave them unset for guided registration.
        </p>
      </details>
      <label className="environment-upload">
        Import .env file
        <input
          type="file"
          disabled={!metadata || busy}
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 64_000) {
              setFailed(true);
              setMessage("Choose a .env file smaller than 64 KB.");
              return;
            }
            void file
              .text()
              .then(async (dotenv) => {
                if (await save({ dotenv })) input.value = "";
              })
              .catch(() => {
                setFailed(true);
                setMessage("Could not read this file.");
              });
          }}
        />
      </label>
      <p className="environment-help">
        Quoted multiline values are supported in files. No shell commands or
        variable substitutions are executed.
      </p>
      <form
        className="environment-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const name = String(data.get("name"));
          const value = String(data.get("value"));
          void save({ values: { [name]: value } }).then((saved) => {
            if (saved) form.reset();
          });
        }}
      >
        <label>
          Variable name
          <input
            name="name"
            disabled={busy}
            required
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            maxLength={128}
            autoComplete="off"
            placeholder="GITHUB_APP_ID"
          />
        </label>
        <label>
          New value
          <input
            name="value"
            disabled={busy}
            type="password"
            maxLength={16384}
            autoComplete="new-password"
            placeholder="Enter a value to save or replace"
          />
        </label>
        <button className="primary" type="submit" disabled={!metadata || busy}>
          Save variable
        </button>
      </form>
      <h3>Saved variables</h3>
      {!metadata && !failed && <p role="status">Loading variable names…</p>}
      {metadata?.names.length === 0 && (
        <p>No variables saved. Environment setup is optional.</p>
      )}
      <ul className="environment-variables">
        {metadata?.names.map((name) => (
          <li key={name}>
            <code>{name}</code>
            <span>Value stored</span>
            <button
              disabled={busy}
              aria-label={`Remove ${name}`}
              onClick={() => {
                void save({ remove: [name] });
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {message && <p role={failed ? "alert" : "status"}>{message}</p>}
    </section>
  );
}
export function Environment() {
  return (
    <div className="environment-page">
      <div className="page-intro">
        <h1>Environment</h1>
        <p>
          Shared by all connectors in your session. Encrypted and private; never
          added to the server’s global environment or assistant tools.
        </p>
      </div>
      <Variables />
    </div>
  );
}
