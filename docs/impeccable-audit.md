# Impeccable resolve log

## Replacement workbench and live overlay

The user subsequently rejected preserving the original visual design and requested a replacement. The app now uses a cool neutral/cobalt workbench: compact connector rail, active auth workspace, and a runtime context column derived from the same ceremony client. The old marketing hero, ornamental glyphs and serif display treatment were removed. Template studio inherits the new system; the reusable package remains independently stylable.

**Impeccable LIVE is now running**, not merely its detector. The app remains at `http://127.0.0.1:4173`; its injected live helper uses port 8401. The browser exposes Pick element, Insert, Detect, Design, Steer and Exit controls. The foreground event poll is serviced by the active agent. On a remote machine, both the app and helper ports must be reachable from the user's browser. This live session is separate from the native Codex file-edit hook limitation described below.

Full verification on the replacement passed: formatting, TypeScript, 18 Node tests, production build and 14 browser tests, including packed React/Vue consumers. The development overlay itself adds accessibility findings; product tests prevent its `live.js` request rather than disabling axe rules. Vite's build-only HTML transform removes the injected helper block from production output, verified in `web-dist/index.html`. The live app retains the overlay.

Independent finish review: **ship**, scoped to the captured initial Connect state at 1440px and 390px. The reviewer first requested an unobstructed mobile capture; the editor bar was hidden only in the audit browser DOM for that capture and immediately restored. The resulting evidence is `.impeccable/review/desktop.png` and `.impeccable/review/mobile.png`. Other auth states are covered by functional browser tests, not by that visual verdict. This was code-led work, not a user-approved image-comp reproduction. The asynchronous direction choice had no answer when implementation proceeded with the proposed workbench.

The first detector run after replacement reported old-design palette/type/radius drift because the prior extraction was still present. The documentation handoff replaces that obsolete extraction with the built system; no old-palette restoration or detector suppression is appropriate for an explicitly requested redesign. The earlier audit scores below describe the superseded design, not the new workbench.

## Requested rerun

The subsequent Impeccable audit and polish pass found and resolved four local demo defects: navigation/toolbar/disclosure touch targets below 44px (P2), a press transform not respecting reduced motion (P2), mobile heading tracking below the craft floor (P3), and a clipped method label on mobile (P2). Shared control sizing, a motion preference guard, proportional tracking, and wrapping the method picker addressed these without changing auth behavior. Browser regression checks now measure navigation/toolbar targets and verify the reduced-motion pressed state. No P0/P1 defects were found in this rerun.

Implementation integrity: **pass**. Auth-specific runtime bindings, host-owned themes and deterministic WebMCP execution remain intact. The installed detector returned `[]` both before and after this pass; the additional findings came from source review and rendered inspection, not the detector.

| Dimension                | Score     | Evidence / limit                                                                                                         |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Accessibility            | 3/4       | Desktop/mobile axe clean; keyboard and reduced-motion checks pass. No screen-reader certification.                       |
| Performance              | 3/4       | No new dependencies or layout animation; demo main bundle about 125KB gzip. No device performance benchmark.             |
| Responsive design        | 4/4       | Inspected 390px and 1280px layouts; control sizing and picker wrapping corrected. External host text-scaling tests pass. |
| Theming                  | 3/4       | Library supports host light/dark tokens; the branded demo remains a fixed light surface.                                 |
| Implementation integrity | 4/4       | Detector clean; shared execution, isolated credentials and packed external consumers verified.                           |
| **Total**                | **17/20** | **Good; scoped engineering assessment, not conformance certification.**                                                  |

Positive patterns: fixes live in shared rules, optional library styles do not leak into host controls, and native forms retain their semantics. The resolved systemic gap was compact demo controls lacking a shared minimum touch size. No further implementation changes are recommended by this bounded pass. Existing deployment/provider-certification limits still apply.

Full verification after the touch/motion fixes passed 18 Node tests and 14 browser tests. The final picker-only CSS adjustment receives a separate focused accessibility/layout rerun. Desktop/mobile visual captures are `/tmp/ceremony-impeccable-rerun-desktop.png` and `/tmp/ceremony-impeccable-rerun-mobile.png` (captured before the final picker adjustment).

Date: 2026-09-08. Scope: reusable auth library, Connect page, and template studio. Audience and embedding priorities confirmed by the user in [PRODUCT.md](../PRODUCT.md). The requested resolve loop continued until the detector and automated accessibility checks were clean; no findings were suppressed.

## Setup

- Installed official Impeccable 4.2.3 at `/home/codex/.codex/skills/impeccable`; its executable launcher and detector work.
- Initialized product context, enabled the project hook policy in `.impeccable/config.json`, and recorded local consent separately in ignored `config.local.json`.
- Configured the live HTML target in `.impeccable/live/config.json`; CSP detection found no policy. No CSP was weakened and no live helper was injected.
- A future code-first versus image-comp-first default was not confirmed, so no `buildPath` preference was saved. This work refined the existing interface.
- **Native automatic Codex hooks are not wired.** The hook command reported no installed provider skill folders to repair. This workspace's `.codex` and `.agents` directories are read-only. Enabling the Impeccable policy does not mean the Codex event hook is active. Manual detector execution supplied the resolve loop. A final hook-status refresh was rejected by the approval service because its usage limit was exhausted; no workaround was attempted. Complete provider hook installation from a writable, trusted project configuration and verify activation through Codex `/hooks` before relying on automatic execution.

## Findings and resolutions

| Finding                                                                                                    | Severity | Resolution and evidence                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime dispatcher depended on React, preventing reuse of the same execution semantics in other frameworks | High     | Extracted the client, transport and WebMCP into the core export. Packed Vue app completes auth and native WebMCP reads without React installed.                                                  |
| Styling depended on the demo shell; hosts could not replace the whole view while retaining execution       | High     | Optional scoped CSS, host theme tokens, render-function composition, `useCeremony` and `CeremonyView`. Packed host verifies two themes, RTL, independent state, host buttons and no CSS leakage. |
| Repeated instances reused field IDs                                                                        | Moderate | React-generated instance IDs bind labels and inputs; packed host asserts every DOM ID is unique.                                                                                                 |
| Same-connector landmarks had identical names                                                               | Moderate | Added host `aria-label` support to both stock component and view; external light/dark instances pass axe with meaningful distinct names.                                                         |
| Secondary demo text failed contrast on cream and selected-tile backgrounds                                 | Serious  | Darkened the shared muted token and reused it for navigation/footer. Connect and studio pass axe at desktop and mobile sizes.                                                                    |
| Mobile form inputs used 14px text                                                                          | Moderate | Inputs now use 16px text in the demo and 1rem in the optional library stylesheet.                                                                                                                |
| Notice used an ornamental colored side border (`side-tab` detector warning)                                | Warning  | Replaced it with a full subtle border; subsequent detector output is empty.                                                                                                                      |
| Redundant eyebrow copy and overly tight heading tracking                                                   | Polish   | Removed the redundant headings and used proportional heading tracking.                                                                                                                           |

## Verification

`npm run verify` passed after the fixes: formatting, TypeScript, 18 Node unit/protocol tests, library/demo production build, and 14 Chromium browser tests. External fixtures were installed from the built tarball and production-built in isolated directories, not resolved through source aliases. Final packed-consumer evidence directory: `/tmp/ceremony-consumers-KUbYDD`.

Coverage includes credential rejection/retry, OAuth PKCE/callback, device approval, anonymous registration/claim, cancellation, reload, session/origin boundaries, template generation/export/import with the model offline, and native WebMCP execution and sanitized hooks. Adoption checks include React host composition, Vue without React, unique IDs, light/dark contrast, RTL, mobile overflow and 200% text sizing. Connect and studio pass full-page axe checks at 1280px and 390px; stock external forms pass scoped axe checks at both sizes. No axe rules were disabled.

The installed detector command `impeccable detect --json src examples/web` returned `[]` after remediation. Desktop and mobile screenshots were visually inspected during the pass. Automated accessibility checks are not a screen-reader certification or proof of every possible host theme/state. Hosts remain responsible for the accessibility of replacement views and themes.

The build succeeds with Vite warnings about client directives in the standalone demo bundle and third-party Zod annotations. The unbundled library retains its client directives. No warnings were hidden. External provider certification, production storage, package publication and non-React OpenUI renderers remain outside the supported slice; see [integration](integration.md) and [auth coverage](auth-catalog.md).

## Approved orchestration extension — 2026-09-08

Preserved the workbench world and added explicit live/simulation modes, an ordered prerequisite summary and mobile task-before-context ordering. The manual target detector returned `[]`. The independent finish reviewer found one material mismatch: live GitHub App documentation linked to OAuth Apps. The corrected manifest documentation link has a browser assertion. Same-viewport recaptures are `.impeccable/review/github-desktop.png` (1440×1000 viewport) and `github-mobile.png` (390×844 viewport). The verdict pass scored the finding resolved and returned **ship at the ready-UI scope**, not live-provider certification.

The independent documenter compared PRODUCT.md, DESIGN.md, its sidecar, the direction contract, implementation/CSS and both screenshots. The extension retains the incumbent palette, typography and controls. Existing design-system files were preserved; their older disclosure/provider descriptions and omission of the new prerequisite summary were reported, not silently rewritten.

Full `npm run verify` passed after runtime fixes: formatting, TypeScript, **25 Node tests**, production library/demo builds and **17 Chromium tests**. Packed React/Vue evidence: `/tmp/ceremony-consumers-CtbOFn`. New checks cover encrypted restart/recovery, scoped one-use secret references, durable outbox redelivery, signed A2H responses, MCP transport secret exclusion, live GitHub prerequisite bypass rejection, private browser collection and vault file-serving denial. No accessibility rules or build warnings were suppressed.

GitHub protocol evidence uses real cryptography with fixture HTTP responses; browser tests stop before external app creation. Real GitHub account completion, Cloudflare takeover, A2H gateway delivery and private-field telemetry isolation in an actual MCP host remain unverified. [Live authentication](live-auth.md) records configuration and exact implementation limits. The approved orchestration design is therefore not fully delivered yet.

## Environment extension — 2026-09-08

Added optional native `.env` import and connector-scoped private variable editing. The target detector returned `[]`. Desktop (1440×1000) and mobile (390×844) captures are `.impeccable/review/environment-desktop.png` and `environment-mobile.png`. Both pass axe and overflow checks. The finish reviewer requested preserving masked drafts on failed saves; the fix has an injected-503/retry browser regression and was scored resolved, disposition **ship**. The documenter confirmed the incumbent system is preserved; existing DESIGN.md/sidecar omissions for the Environment container, breakpoint and navigation were reported without rewriting those files.

The final settled-source `npm run verify` passed formatting, TypeScript, **26 Node tests**, production builds and **18 browser tests**. Packed React/Vue evidence: `/tmp/ceremony-consumers-h9yRI6`. A prior run's WebMCP context was interrupted while development files were reloading; the clean complete rerun passed without suppressions. Environment checks cover import/replace/remove, owner/connector isolation, names-only responses, size/revision/origin rejection and actual GitHub setup consumption. Existing external-provider certification limits remain unchanged.
