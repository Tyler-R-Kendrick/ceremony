# Browser login extension (draft preview)

This is a Manifest V3 browser extension, not a desktop executable, remote browser, or password manager. Execution and optional inference stay in the browser. The extension uses the selected tab's normal cookie session. One source tree builds two artifacts: a Chromium ZIP and a Firefox (Gecko) XPI. Both run the same worker, isolated-world adapter and trusted UI through `extensions/browser-login/platform.ts`, which is the only place the two browsers' APIs differ.

## Install from Ceremony

Run `npm run build:extension`, then `npm run dev`. Open Ceremony at http://127.0.0.1:4173 and expand **Browser login extension · Set up**. Download the ZIP, extract it into a permanent folder, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. Select the folder containing `manifest.json`. Return to Ceremony and check connection, then open browser login.

The unpacked path is this checkout's `extension-dist/chromium` directory; the build also prints the absolute path. Do not select the source directory or ZIP. Keep the loaded folder in place. To update, replace its contents and click Reload on its extension card. The website cannot silently install an extension or bypass browser permission prompts.

`npm run build:extension` also builds the Firefox artifact; see **Firefox** below. `npm run build` builds and copies the Chromium extension ZIP into the static web output. No source, secrets, browser profiles, environment files, or diagnostics enter the archive. `zip` is required for building; `unzip` is also required for artifact tests. Build metadata includes the stable unpacked extension ID, version, protocol version and ZIP SHA-256. The ID identifies this public build, not cryptographic proof of its publisher. Store publication is not implemented.

For hosted installations, set `CEREMONY_EXTENSION_APP_ORIGINS` to comma-separated exact application origins **when building** — HTTPS, or `http://127.0.0.1` with an explicit port, which is the same rule the extension applies to a login origin. The manifest admits messaging from those hosts; the worker additionally checks exact origins including ports. The default admitted development app is http://127.0.0.1:4173. A hosted app not admitted in the installed artifact cannot open or ping it. Rebuild and reinstall after changing this configuration.

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

## Firefox

`npm run build:extension` writes `extension-dist/firefox/` and packs it as `extension-dist/ceremony-browser-login-firefox.xpi`. Both targets' version, protocol version and SHA-256 are written to `extension-dist/metadata.json`. **The XPI is unsigned and is a development artifact.** Nothing in this repository signs, uploads or publishes it, and `metadata.json` records `"signed": false` and `"distribution": "development-only"`. Only the Chromium ZIP is copied into the web output and offered by the on-page installer; Firefox is installed from the checkout.

Install it as a temporary add-on: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extension-dist/firefox/manifest.json` (or the XPI). A temporary add-on is removed when Firefox closes. A permanent install in Firefox release or beta requires a signed add-on, which is not implemented; Developer Edition, Nightly or ESR can install the unsigned XPI with `xpinstall.signatures.required` set to false, which is a change to browser security settings and is not required for the temporary-add-on path.

Three Gecko differences are handled in the artifact, not papered over:

- **Background.** MV3 on Firefox is a `background.scripts` event page, not a `service_worker`, and the add-on declares `browser_specific_settings.gecko.id`. Permissions, optional host permissions and CSP are identical to the Chromium manifest.
- **App bridge.** Firefox does not implement Chromium's `externally_connectable` webpage-to-extension messaging, so the Chromium app-bridge path does not exist there. In its place the Firefox manifest registers `relay.js` as a content script on the configured app origins only, and the page reaches the extension with `window.postMessage`. The relay admits a message only when the document it runs in is one of the exact configured origins, `event.source === window`, `event.origin` equals that same exact origin, and the message matches a strict schema; the admitted origins are compiled into `relay.js` rather than fetched from a web-accessible resource. The worker then repeats the exact-origin admission against the origin the browser attests for the sender, exactly as it does for `externally_connectable`. Match patterns cannot carry a port, so the manifest can only narrow the relay to the app _host_; the port is enforced in code. Host permissions are not widened: `host_permissions` and `optional_host_permissions` are byte-identical to the Chromium manifest, so a hosted HTTPS app origin needs the user to grant that site before the relay runs there. Handoffs travel the same relay over a `ceremony.handoffs` port and keep their per-attempt `handoffRef`; the relay echoes the reference it was asked about and never mints one.
- **Document binding.** Chromium returns a document id from `scripting.executeScript` and accepts it on `tabs.sendMessage`; Firefox has neither. On Firefox the run is instead bound to the per-document reference the isolated world mints and returns in its observation, that reference travels in every subsequent message, and the isolated world refuses any message naming a different document. Chromium's behaviour is unchanged. The one message this does not cover is the first `observe` immediately after injection, which on Firefox is addressed by frame rather than by document; its reply establishes the reference that binds everything after it, and the observation's origin is still checked.

### What is proven on Firefox, and what is not

Proven by `tests/extension-firefox-load.test.ts`, which installs the built directory into a real Playwright-launched Firefox over the remote debugging protocol (the same `installTemporaryAddon` call `web-ext run` makes): the add-on installs with no manifest warnings, the MV3 event page reaches `RUNNING` as a non-persistent background script, a page on the exact configured app origin completes a `ceremony.ping` round trip through the relay, and an identical page on the same host at a different port gets no answer at all.

Also proven, against a Gecko-shaped API rather than a browser, by `tests/extension-firefox-binding.test.ts`: without document ids the worker binds the run to the reference the isolated world minted, carries it in every later message and addresses the frame; the isolated world refuses any message naming a different document while still refusing other extensions and page senders; reserve-before-dispatch still blocks a replay; and the relay bridge admits exactly the configured app origin and nothing else, including the same host on another port.

Not proven, and not claimed: the login flow itself on Firefox. Playwright cannot open `moz-extension://` pages, so the trusted UI, the permission prompt, inspection, the mapping review and submission are implemented but untested on Gecko; they are covered on Chromium only. Signing, AMO review or distribution, and installation into a pre-existing Firefox profile as a permanent add-on are not implemented.

## Permissions and limitations

The current development preview declares loopback host access for the owned fixture and `tabs` to select an already open tab by exact URL. HTTPS host access is optional and requested per site. This is broader tab-metadata visibility than the eventual minimal-permission design; store review should reconsider it. There is no debugger, cookies, native messaging, screenshot, or arbitrary-script interface.

This draft is **not an autonomous login engine**. Human review is required before the first submission of a run. The Ceremony page lists a fixture-only executable profile and discovery-only GitHub, Google and Microsoft entries. Those live entries are not executable: they have zero submission budget, no sequences, and no account verifier. Public sign-in landings may be opened from the catalog; that is not authenticated provider certification. Attended multi-step, explicit frame origin targeting, already-open popup driving (original tab as opener), and handoff events/hooks are implemented. There is no built-in passkey, CAPTCHA, or MFA resolver, password-manager integration, or store installer. Results are `submitted-unverified` unless the owned loopback fixture proves its expected account. The site is necessarily a trusted recipient of filled credentials; content-script isolation does not hide DOM values from it.

## Verification

- `npm run check`
- `npm run build:extension`
- `node --import tsx --test tests/extension-loading.test.ts tests/extension-template.test.ts tests/extension-login.e2e.test.ts tests/browser-login-catalog.test.ts tests/browser-login-flows.test.ts tests/browser-login-handoff.test.ts`
- `node --import tsx --test tests/extension-platform.test.ts tests/extension-firefox.test.ts tests/extension-firefox-relay.test.ts tests/extension-firefox-binding.test.ts tests/extension-firefox-load.test.ts`
- `node --import tsx --test --test-concurrency=1 tests/extension-multistep.test.ts`
- `npm test`
- `npm run build`

The E2E rebuilds, extracts the **downloadable ZIP**, loads it into a fresh Chromium profile, approves a synthetic login through the trusted UI, and verifies a real POST/cookie-backed account page. This proves the owned fixture only, not live provider certification. The initial worker timeout was caused by an early build script lacking dependency bundling; that duplicate script has been removed. The retained build bundles dependencies, and artifact execution guards against recurrence.
