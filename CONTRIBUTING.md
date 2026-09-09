# Working on Ceremony

Start with [development setup](docs/development.md), the [architecture](docs/architecture.md), and the [test guide](docs/testing.md). Product scope is in [PRODUCT.md](PRODUCT.md); the example's design contract stays in [DESIGN.md](DESIGN.md) for design-tool discovery.

## Before changing code

- Use Node 24 (`nvm use`) and `npm ci`. Commit dependency changes with `package-lock.json`; do not switch package managers or regenerate unrelated dependencies.
- Work from the repository root. Preserve existing changes, encrypted `.ceremony/` data, `.env` files, Workflow history, and evidence. A managed/read-only `.git` directory is not permission to replace it.
- Keep core imports framework-neutral. Model, storage and hosted SDKs belong behind server exports; host styling and navigation stay optional.
- Reproduce a fault before fixing it. Separate behavioral changes from structural cleanup. Never weaken authorization, snapshots, privacy diagnostics or mutation gates to get a green result.
- Read scoped `AGENTS.md` instructions when present. Do not put provider credentials, account-identifying captures or model prompts in issues, code review, fixtures or reports.

## Verify and deliver

```sh
npm run format:check
npm run check
npm run verify
```

Run focused tests while editing; run the complete deterministic command before delivery. The broader mutation matrix runs separately in CI. Changes to devcontainer setup also run inside that container in CI. See [testing](docs/testing.md) for discovery, diagnostics, Pact, fuzzing, snapshots, mutation results and external gates.

Use small commits and scoped PRs. State what changed, exact checks and failures, and any external blockers. Review findings need a fix plus regression evidence, or an explicit unresolved release blocker. Squash only the reviewed exact head after its required checks pass; verify the resulting remote tree and retain unrelated/unmerged work.

The package remains private. A passing build or merge does not authorize publication, provider registration, paid resources or production deployment. `verify:release` is a separate evidence gate, not a label to set by hand.
