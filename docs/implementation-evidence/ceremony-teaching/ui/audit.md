# Teaching surface: bounded Impeccable audit

Implementation-integrity verdict: pass for the inspected surface. The existing daylight workbench, native controls, and outcome-first hierarchy remain coherent. This is not external-provider certification or a complete WCAG conformance claim.

| Dimension | Score | Evidence and limit |
| --- | --- | --- |
| Accessibility | 3/4 | Axe returned no violations; keyboard start, pause, resume, stop, and discard passed in three engines. Manual assistive-technology certification was not executed. |
| Performance | 3/4 | No layout-animation or browser model-SDK dependency was added by this surface; wider bundle budgets belong to release verification. |
| Responsive layout | 4/4 | 1440×1000 and 390×844 views, expanded German-size text, 24px body text, and ≥44px teaching actions passed. |
| Theming | 3/4 | Existing palette and CSS variables retained. A separate dark theme is not advertised or certified. |
| Implementation integrity | 4/4 | Mechanical detector returned `[]`. One inaccurate Studio subtitle was corrected and visually confirmed. |
| Total | 17/20 | Good; no outstanding blocking finding in this bounded review. |

The initial P2 finding was the old Studio subtitle describing presentation-only work despite the new demonstration action. It now describes demonstrations, reviewed steps, and presentation customization. No identity, layout, or visual-world redesign was introduced.

Two review rounds were used: one desktop/mobile batch, then one confirmation batch after the copy correction. Images here are Playwright screenshots of the synthetic pre-connection shell, not generated illustrations. They contain no account information, run, provider handoff, credential collector, or Environment editor. Ordinary tests do not capture images; `CEREMONY_CAPTURE_REVIEW=1` explicitly enables this neutral-only pair.

Runnable check: `npx playwright test tests/browser/teaching-accessibility.spec.ts`. Three-engine run passed 3/3; the subsequent Chromium confirmation passed 1/1. Actual browser versions were Chromium 153.0.8010.12, Firefox 155.0, and WebKit 26.6. Tests exercise reduced-motion behavior without disabling all animations globally.

Images: [desktop](teaching-neutral-1440.png), [mobile](teaching-neutral-390.png).

Impeccable context also reported an older design sidecar and unset build-path metadata. These were not silently rewritten during a verification task. No Impeccable hosting was started.
