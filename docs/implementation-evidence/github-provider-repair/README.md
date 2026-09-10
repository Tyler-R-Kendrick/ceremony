# GitHub provider repair evidence

## Delivered correction

The GitHub manifest now registers a stable installation setup URL. Subject-bound, expiring state routes the callback to the current parent, including when an existing app is reused. Personal and organization targets use their respective registration endpoints. Installation state, protected artifact and return-state consumption commit atomically.

Expired issued registrations enter recovery rather than silently creating another app. An authenticated, revision-bound native recovery action can explicitly authorize a new attempt only when no app or installation is attached. Existing app recovery remains the preferred path. Account signup is a provider-owned browser handoff, not a simulated successful account creation.

The local provider fixture now follows the manifest's registered setup URL instead of manufacturing a callback that concealed the defect. Production Vercel output includes static assets, API and Workflow functions; the emitted handler is exercised over HTTP and rejects missing production configuration.

## Executed evidence

- [Commands](commands.json): complete deterministic verification, 315 Node tests, 2 Workflow tests, 109 killed security mutants, 76 browser tests; no failed or skipped tests in the final run. Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6.
- [Coverage](coverage.json) and [bundle measurement](bundle.json) are copied from that run.
- [Live handoff](live-handoff.json): the actual local Connect UI reached GitHub login without provider interception. No app, account or grant was created. The local attempt was cancelled afterward. No provider DOM, screenshots, credentials or private URLs were retained.
- Independent source review found no remaining critical/high findings in the bounded callback/recovery correction.

These are local working-tree results, not commit-bound production certification. The managed source checkout supplied no commit ID; the command result records null rather than inventing one.

## Failure history and fixes

An earlier full verification failed because Stryker copied a generated Vercel function symlink as a file. Generated deployment and Workflow state directories are now excluded from its sandbox, not production source. Another attempt had two failures from overlapping test fixtures on fixed ports; the final run was isolated. A provider-port startup failure also exposed a resource leak, now fixed and covered for both provider and app port collisions.

Focused GitHub mutation attempts initially reported 26 killed, 4 timeout and 17 survived, then 46 killed and 1 survived. Direct routing and restart assertions closed the gaps. All 47 GitHub mutants were incorporated into the permanent critical-guard gate, whose final total is 109 killed with no survivors or timeouts. Earlier failures are not represented as successful attempts.

## External release gates

Production certification remains blocked, not passed. Real GitHub registration, installation and verified API access require the intended owner's authenticated provider interaction; the executed live check established login reachability only. Hosted Vercel/Workflow deployment was not executed: the connected account has no Ceremony project, and this process has no configured production origin, database, vault key or end-user OIDC configuration. No resources were provisioned or billed. Real installed-PWA platform checks were not executed.

Use the documented production configuration and release verifier after those authorized environments are available. A local build, a fixture grant or the live login page cannot replace that evidence.
