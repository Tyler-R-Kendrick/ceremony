# Browser login extension (draft preview)

This is a Chromium Manifest V3 extension, not a desktop executable, remote browser, or password manager. Execution and optional inference stay in the browser. The extension uses the selected tab's normal cookie session.

## Install from Ceremony

Run `npm run build:extension`, then `npm run dev`. Open Ceremony at http://127.0.0.1:4173 and expand **Browser login extension · Set up**. Download the ZIP, extract it into a permanent folder, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. Select the folder containing `manifest.json`. Return to Ceremony and check connection, then open browser login.

For this worktree the unpacked path is `/home/codex/.herdr/worktrees/ceremony-extension/extension-dist/chromium`. Other checkouts use their own absolute path printed by the build. Do not select the source directory or ZIP. Keep the loaded folder in place. To update, replace its contents and click Reload on its extension card. The website cannot silently install an extension or bypass browser permission prompts.

`npm run build` builds and copies the extension ZIP into the static web output. No source, secrets, browser profiles, environment files, or diagnostics enter the archive. `zip` is required for building; `unzip` is also required for artifact tests. Build metadata includes the stable unpacked extension ID, version, protocol version and ZIP SHA-256. The ID identifies this public build, not cryptographic proof of its publisher. Store publication is not implemented.

For hosted installations, set `CEREMONY_EXTENSION_APP_ORIGINS` to comma-separated exact HTTPS application origins **when building**. The manifest admits messaging from those hosts; the worker additionally checks exact origins including ports. The default admitted development app is http://127.0.0.1:4173. A hosted app not admitted in the installed artifact cannot open or ping it. Rebuild and reinstall after changing this configuration.

## Execution

1. Open one tab at the desired login URL, then open the extension from Ceremony or its toolbar action.
2. Enter that exact URL and approve the site's permission request. Multiple tabs at the same URL are rejected rather than choosing one silently.
3. Review the detected credential roles and exact form recipient in extension-owned UI.
4. Enter credentials and approve one submission. Credentials are cleared from the extension UI after dispatch. No credentials enter inference or persisted run state.
5. Verify the result in the provider tab. For identifier-first flows, inspect the next page again and approve the next step.

Packaged templates recognize combined-login, identifier-first and password-only form steps. They admit same-origin POST forms only. Bindings are document-scoped and mutations invalidate observations. Submitted effects are reserved in session storage before dispatch and cannot be replayed through the same run. A worker interruption after dispatch can leave an uncertain outcome: inspect the page rather than resubmit blindly. Session storage is not durable across browser restarts.

### Inference

Mapping uses Vercel AI SDK `generateText` with a local provider adapter and Transformers.js. The selected free downloadable model is `onnx-community/SmolLM2-135M-Instruct`, q4 on WASM. Runtime JavaScript and WASM are bundled locally; only model data downloads from Hugging Face. There is no API key, remote inference endpoint, paid fallback, or model call on the deterministic path. First use requires network access and model storage and can time out on constrained devices. The UI explicitly opts into the model download.

Inference receives only bounded control descriptions and opaque refs; input values are omitted. Labels remain untrusted and can contain sensitive page text, which is why inference is local. It proposes refs only, cannot generate executable code, and its output must pass the same form/recipient checks and human review. CI tests the actual AI SDK boundary with a stub text generator. Live model quality and extension WASM/model-download compatibility are **not certified** by those tests.

## Permissions and limitations

The current development preview declares loopback host access for the owned fixture and `tabs` to select an already open tab by exact URL. HTTPS host access is optional and requested per site. This is broader tab-metadata visibility than the eventual minimal-permission design; store review should reconsider it. There is no debugger, cookies, native messaging, screenshot, or arbitrary-script interface.

This draft is **not the entire planned autonomous engine**. It requires review per step and has no reviewed third-party profile catalog, authoritative account verifier, automatic multistep navigation, popup/SSO adoption, cross-origin-frame driver, password-manager integration, or store installer. It reports submitted-unverified, never claims a verified account based on DOM disappearance. CAPTCHA, passkeys, MFA and new consent require direct user participation. The site is necessarily a trusted recipient of filled credentials; content-script isolation does not hide DOM values from it.

## Verification

- `npm run check`
- `npm run build:extension`
- `node --import tsx --test tests/extension-loading.test.ts tests/extension-template.test.ts tests/extension-login.e2e.test.ts`
- `npm test`
- `npm run build`

The E2E rebuilds, extracts the **downloadable ZIP**, loads it into a fresh Chromium profile, approves a synthetic login through the trusted UI, and verifies a real POST/cookie-backed account page. This proves the owned fixture only, not live provider certification. The initial worker timeout was caused by an early build script lacking dependency bundling; that duplicate script has been removed. The retained build bundles dependencies, and artifact execution guards against recurrence.
