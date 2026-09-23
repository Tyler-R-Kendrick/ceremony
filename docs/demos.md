# Demo videos

These are short screen recordings of an agent doing auth ceremonies end to end. They are made with [webreel](https://github.com/vercel-labs/webreel) (`@webreel/core`), and every action on a provider page is performed by Ceremony's own driver. They are demonstrations against this repository's [self-hosted test provider](auth-scenario-doubles.md). They are not evidence about any real service, and no real account is involved.

Account registration comes first because API-driven agents most often fail at it. An agent there has to obtain an address it can actually receive mail at, fill a form it has never seen, read an emailed code and prove the account exists.

## The videos

| Demo                                  | Scenario double                             | What it shows                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. The agent creates an account**   | `registration-with-emailed-code`            | A provider the agent has never seen. A fresh agent-inbox address, a generated password (masked), the emailed code extracted from the inbox (never displayed), and the provider confirming the account exists.                                                                                                                     |
| 2. Registration recovers              | `registration-recovers-with-fresh-address`  | The person's usual address is already registered. The provider refuses it, the agent inbox issues a fresh address, and registration finishes with it. The original account is left untouched and exactly one new account exists.                                                                                                  |
| **3. Connect an API, no account yet** | `authorization-requires-registration-first` | The stitched run. An OAuth authorization-code request with PKCE finds no account, so in one browser run the agent registers, verifies through the inbox and approves consent. The connector then redeems the code with its verifier and checks that the token names the new account, and that the same code is refused on replay. |
| 4. Record once, replay with no model  | `registration-with-emailed-code`            | The first registration is interpreted and recorded as value-free steps. A second registration for a new address replays that recording with zero interpreter calls.                                                                                                                                                               |

In the stitched demo, a side panel and the caption row show the chain position (`Step 4/7 · verify email via inbox`). It advances from what the driver was about to do and on which page, never from elapsed time.

## What is real and what is a double

| Layer                 | In the videos                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider              | **Double.** The self-hosted test provider in `tests/doubles/auth-provider`: real HTML over real HTTP with sessions, validation, confirmation mail, and authorization code + PKCE. Pages are synthetic and randomized per seed, and each title card names its seed. |
| Browser               | Real Chrome, launched and recorded by `@webreel/core`.                                                                                                                                                                                                             |
| Driver                | Real: `runCeremony` and `runRecordedCeremony` over `createPlaywrightCeremonyPage`, attached to webreel's Chrome over CDP.                                                                                                                                          |
| Next-step decisions   | Real: `createHeuristicInterpreter`, the production model-free interpreter. It reads only the sanitized snapshot. No model is called and no test double decides anything.                                                                                           |
| Password              | Real generator: `generateIsolatedAccount`.                                                                                                                                                                                                                         |
| Agent inbox           | Real adapter and extraction (`createHttpInbox`, `verificationFromMessage`). **Mail transport is simulated.** A small local service exposes the provider double's outbox in the inbox contract.                                                                     |
| OAuth client (demo 3) | **Double.** The test provider's relying-party helper builds the authorization request and redeems the code. The callback lands on a separate local "connector" origin, as it would in production.                                                                  |

## What a video may show

A recording is made to be shared, so it is held to a stricter rule than a transcript. Captions, side panels and cards name **who** acted and **which step** they took, never **what** they typed.

- Every caption and panel row comes from closed vocabularies in `scripts/demos/captions.ts`. `tests/demos-captions.test.ts` pushes canary passwords, codes, links, tokens and addresses through every field of every entry point, including fields the types do not allow.
- A scenario marks each value it handles with `protect` (the generated password, every code and link the inbox serves, the PKCE verifier and the access token). The recorder refuses to keep a video if one of them reached a caption, a card or the driver's transcript.
- Password fields are masked by the page. A verification code is visible in the provider's own text input while the driver fills it. It is a synthetic value from the double, and no caption or panel prints it. Synthetic addresses (`*.invalid`, `*.test`) appear in forms and on the provider's signed-in page.

## How it is built

`scripts/demos/harness.ts` watches the driver without steering it. It has two seams:

1. The interpreter is wrapped, so each proposal becomes a caption before the driver acts on it. A short pause lets a viewer read it.
2. The Playwright page given to the adapter returns element handles whose `fill`, `click` and `check` first move webreel's cursor to that control. Then the driver's own action runs.

Neither seam changes what the driver decides, sees or submits. Nothing is injected into a provider page. Provider pages are shown at 2x device scale rather than restyled, and the side panels are rendered separately and overlaid on the video afterwards.

webreel's own headless mode starts `chrome-headless-shell` with begin-frame control. That stops `requestAnimationFrame`, and with it Playwright's actionability checks. The harness therefore gives webreel's launcher a small wrapper that runs Playwright's Chromium with `--headless=new`, a fixed device scale and a fixed window size. Set `DEMO_CHROME_BINARY` to use a different Chrome.

## Regenerating

```sh
npm run demos:record                                # every demo, in catalog order
npm run demos:record -- agent-creates-account       # one demo by id
npm run demos:record -- --docs                      # also write small previews to docs/demos/
```

Output goes to `artifacts/demos/<id>.mp4` with a poster at `<id>.png`. `artifacts/` is ignored, so a video is regenerated, never edited. `--docs` also writes a small MP4, a GIF and the poster for demos marked `docsPreview` into `docs/demos/`.

Each demo takes about a minute and a half to record and encode. Recording is not part of `npm test`; the catalog, phase and caption rules are, as pure unit tests.

webreel downloads its ffmpeg on first use unless `FFMPEG_PATH` is set or `ffmpeg` is on `PATH`. The build it looks for must include `libx264`. If the download fails (its upstream asset name has moved before), install a static ffmpeg and point `FFMPEG_PATH` at it.

## What the videos do not show

- Any real provider. Recording a live provider would retain exactly what verification is forbidden to keep, so this is never pointed at one. See [auth scenario doubles](auth-scenario-doubles.md).
- A model. The interpreter on screen is the production model-free one; model quality is not demonstrated here.
- Real mail delivery. The inbox adapter and code extraction are real; SMTP is not.
- Second-factor enrollment. The provider double's second factor is a per-account code, not a seed-derived TOTP, so "sign in with TOTP from a seed" is not recorded yet.
- The Ceremony app UI. These videos show the isolated browser the agent drives, not the product surface that starts a run.
