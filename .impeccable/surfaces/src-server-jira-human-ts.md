---
version: 1
slug: "src-server-jira-human-ts"
primary_target: "src/server/jira-human.ts"
related_targets: ["src/react/teaching.tsx"]
---

# Jira private participation

Scope: Operate-mode extension of Connect, not studio authoring. Reuse the existing parent and registered Jira children. Provider login, consent and app registration remain provider-owned; no captured private page imagery.

## Direction contract

THESIS: Connect Jira asks only for the current missing prerequisite; configured apps proceed directly to provider authorization.

OWN-WORLD: Inherit the daylight workbench, cobalt controls, ink system typography and native private fields. No global design changes.

STORY: An integration owner opens Atlassian's developer console, configures the fixed callback and declared scopes, then submits app credentials privately. Other users need owner assistance, not instructions to register their own distributed app. Expired consent has explicit recovery.

FIRST VIEWPORT: One compact heading, current blocker, ordered setup instructions when needed, native fields and one primary action. Return to the same parent remains visible. No assistant, recording or PWA cache surrounds the collector. Preserve keyboard focus and mobile wrapping.

FORM: Code-led narrow extension of the existing connection surface; inherited seed 8302fddc. Native handoff and same-parent return are the signature interaction; no decorative motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implementation checkpoint — 2026-09-10

Source inspection of `src/server/jira-human.ts`, `src/react/teaching.tsx` and `examples/web/main.tsx` confirms a narrow Connect extension: existing connector tiles, operation status, native Jira site URL input and primary handoff link are reused. The isolated app/recovery collector inherits the daylight palette, system typography, 44px controls, cobalt focus and flat white surface. Its compact 680px column and 720px stacking breakpoint are local adaptations, not global tokens; the non-owner fallback remains plain semantic HTML. App setup uses ordered provider instructions and private native fields; recovery requires explicit renewed consent. Both expose return to the connection.

Review disposition remains **FIX**. “Configure Jira for this session” is corrected in source, with source-only reviewer confirmation; cross-owner assignment remains unresolved, so the shared-app wording is not evidence of a completed owner-assistance workflow. The parent reports that the browser fix removes synthetic handoff interception before the native callback and focused Chromium passed; the full matrix is still in progress. The already-checked safe captures, `.impeccable/review/jira-desktop.png` and `.impeccable/review/jira-mobile.png`, show empty Connect only and cannot establish private collector or provider behavior. This documentation pass ran no browser, tests or captures; private collector/provider imagery is prohibited.

`PRODUCT.md`, `DESIGN.md` and `.impeccable/design.json` were checked as incumbent context. The sidecar still names “Template studio” and describes template authoring where current product/design context names Workflow studio and connector authoring. This drift is reported without repair; both global design files remain unchanged. This checkpoint records inheritance and evidence limits, not ship approval or provider certification.
