# Standalone Studio authoring

This corrects Studio's purpose: it creates new connector definitions and ceremonies, independently of Connect and Environment. See [the user guide](../../workflow-studio.md).

## Scope and evidence

Evidence is from the local source checkout based on merged `77e9b54`, not a production release certificate. The source workspace has managed/unavailable Git metadata, so the deterministic runner correctly records `commit: null`. No real provider account, deployed Vercel/Workflow service, or installed-PWA device certification was performed for this change.

- `commands.json`: complete `npm run verify` outcome, actual command exits, counts and runtime/browser versions.
- `coverage.json`: allowlisted numeric coverage from that verification.
- `bundle-size.json`: measured browser bytes and explicit regression budget.
- `mutation-summary.json`: new authoring module mutation results, source/test fingerprints, and both attempts.
- Browser authoring proof: `tests/browser/workflow-studio.spec.ts` runs creation, draft save/reopen, ordered workflows, imported document changes, saved presentation restoration, request isolation, accessibility and mobile checks in Chromium, Firefox and WebKit.
- Existing `ceremony.spec.ts` exercises model generation over HTTP with an authored connector name, offline presentation preview, and verifies Connect remains unchanged.
- `connector-authoring.test.ts` executes exported Arazzo through the real existing executor with explicit test handlers; missing bindings fail before effects. This is not certification of a newly authored provider.

## Review

Independent Impeccable review initially returned **fix**: saved presentation restoration, imported document mapping, orphan document removal, and incomplete draft saving needed correction. All four were corrected and regression-tested. The bounded verdict pass marked all four resolved and the synthetic desktop/mobile screens **ship**. Mechanical detector output was empty. Documentation review retained the existing design system and corrected Studio-specific descriptions. Pre-existing design-sidecar drift was not repaired.

## Failure history and mutation interpretation

Early focused attempts found a blank-URL validator exception, inaccessible exact field labels, and generation still supplying a built-in connector ID. These were fixed before the successful complete run. A format check overlapped test edits and failed; the final verification checks the formatted files. The initial new-editor bundle exceeded the previous ceiling; the actual editor cost and explicitly revised total-download budget are documented in the user guide, not hidden by excluding its chunk.

The first new-module mutation attempt failed its unchanged 80% threshold: 212 killed, 57 survived, three uncovered, no timeouts/errors. Independent tests were added for exact byte/identifier limits, multi-document linkage, distinct template families, graph diagnostics and conservative draft defaults. The final run killed 270 of 272 mutants, with no uncovered cases, timeouts or runner errors.

Two equivalent survivors remain visible, not suppressed or counted as killed:

1. Returning `true` instead of `false` when `URL.canParse` fails cannot accept the value: the preceding Zod URL validation has already rejected it. Either early return also avoids calling `new URL` on invalid input.
2. Removing optional chaining from `doc?.info.version` has no observable effect: the right side of `!workflow || ...` is never evaluated when the document/workflow is absent.

Test reports deliberately omit credentials, provider bodies, model prompts, private DOM and auth screenshots. Visual review used only synthetic Acme authoring definitions.
