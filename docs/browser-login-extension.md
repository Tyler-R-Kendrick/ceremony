# Browser login extension (draft preview)

This is a Chromium Manifest V3 extension, not a desktop executable, remote browser, or password manager. Execution and optional inference stay in the browser. The extension uses the selected tab's normal cookie session.

## Install from Ceremony

Run `npm run build:extension`, then `npm run dev`. Open Ceremony at http://127.0.0.1:4173 and expand **Browser login extension · Set up**. Download the ZIP, extract it into a permanent folder, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. Select the folder containing `manifest.json`. Return to Ceremony and check connection, then open browser login.

The unpacked path is this checkout's `extension-dist/chromium` directory; the build also prints the absolute path. Do not select the source directory or ZIP. Keep the loaded folder in place. To update, replace its contents and click Reload on its extension card. The website cannot silently install an extension or bypass browser permission prompts.

`npm run build` builds and copies the extension ZIP into the static web output. No source, secrets, browser profiles, environment files, or diagnostics enter the archive. `zip` is required for building; `unzip` is also required for artifact tests. Build metadata includes the stable unpacked extension ID, version, protocol version and ZIP SHA-256. The ID identifies this public build, not cryptographic proof of its publisher. Store publication is not implemented.

For hosted installations, set `CEREMONY_EXTENSION_APP_ORIGINS` to comma-separated exact HTTPS application origins **when building**. The manifest admits messaging from those hosts; the worker additionally checks exact origins including ports. The default admitted development app is http://127.0.0.1:4173. A hosted app not admitted in the installed artifact cannot open or ping it. Rebuild and reinstall after changing this configuration.

## Execution

1. Open one tab at the desired login URL, then open the extension from Ceremony or its toolbar action.
2. Enter that exact URL and approve the site's permission request. Multiple tabs at the same URL are rejected rather than choosing one silently.
3. Review the detected credential roles and exact form recipient in extension-owned UI.
4. Enter credentials and approve. Credentials are cleared from the extension UI after dispatch. No credentials enter inference or persisted run state.
5. Verify the result in the provider tab.

Without multi-step mode, one approval submits one same-origin form. Opt in to attended multi-step for identifier → password on the same approved origin (at most two submissions). Fixture profile verification is loopback-only. Frame and already-open popup targeting require multi-step mode, an explicit destination origin, and — for a popup — the original login tab as opener. No other tabs or redirects are adopted.

CAPTCHA, passkeys, native dialogs, and unmatched next pages emit a portable `handoff` event (run id, named reason, exact origin, attempt). Observers cannot change the outcome. `subscribeHandoffs` on the Ceremony page — or a `ceremony.handoffs` extension port — lets an owning app resolve the handoff (`completed` / `declined` / `unavailable`). `completed` is a claim: the run resumes and re-reads the page; it does not replay a reserved submission and does not count as verification. Without a resolver the run stops, which is the default human path.

Packaged templates recognize combined-login, identifier-first and password-only form steps. They admit same-origin POST forms only. Bindings are document-scoped and mutations invalidate observations. Submitted effects are reserved in session storage before dispatch and cannot be replayed through the same run. A worker interruption after dispatch can leave an uncertain outcome: inspect the page rather than resubmit blindly. Session storage is not durable across browser restarts.

### Inference

Mapping uses Vercel AI SDK `generateText` with a local provider adapter and Transformers.js. The selected free downloadable model is `onnx-community/SmolLM2-135M-Instruct`, q4 on WASM. Runtime JavaScript and WASM are bundled locally; only model data downloads from Hugging Face. There is no API key, remote inference endpoint, paid fallback, or model call on the deterministic path. First use requires network access and model storage and can time out on constrained devices. The UI explicitly opts into the model download.

Inference receives only bounded control descriptions and opaque refs; input values are omitted. Labels remain untrusted and can contain sensitive page text, which is why inference is local. It proposes refs only, cannot generate executable code, and its output must pass the same form/recipient checks and human review. CI tests the actual AI SDK boundary with a stub text generator. Live model quality and extension WASM/model-download compatibility are **not certified** by those tests.

## Permissions and limitations

The current development preview declares loopback host access for the owned fixture and `tabs` to select an already open tab by exact URL. HTTPS host access is optional and requested per site. This is broader tab-metadata visibility than the eventual minimal-permission design; store review should reconsider it. There is no debugger, cookies, native messaging, screenshot, or arbitrary-script interface.

This draft is **not an autonomous login engine**. Human review is required before the first submission of a run. The Ceremony page lists a fixture-only executable profile and discovery-only GitHub, Google and Microsoft entries. Those live entries are not executable: they have zero submission budget, no sequences, and no account verifier. Public sign-in landings may be opened from the catalog; that is not authenticated provider certification. Attended multi-step, explicit frame origin targeting, already-open popup driving (original tab as opener), and handoff events/hooks are implemented. There is no built-in passkey, CAPTCHA, or MFA resolver, password-manager integration, or store installer. Results are `submitted-unverified` unless the owned loopback fixture proves its expected account. The site is necessarily a trusted recipient of filled credentials; content-script isolation does not hide DOM values from it.

## Verification

- `npm run check`
- `npm run build:extension`
- `node --import tsx --test tests/extension-loading.test.ts tests/extension-template.test.ts tests/extension-login.e2e.test.ts tests/browser-login-catalog.test.ts tests/browser-login-flows.test.ts tests/browser-login-handoff.test.ts`
- `node --import tsx --test --test-concurrency=1 tests/extension-multistep.test.ts`
- `npm test`
- `npm run build`

The E2E rebuilds, extracts the **downloadable ZIP**, loads it into a fresh Chromium profile, approves a synthetic login through the trusted UI, and verifies a real POST/cookie-backed account page. This proves the owned fixture only, not live provider certification. The initial worker timeout was caused by an early build script lacking dependency bundling; that duplicate script has been removed. The retained build bundles dependencies, and artifact execution guards against recurrence.
