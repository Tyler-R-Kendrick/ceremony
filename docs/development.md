# Development setup

## Host setup

The repository root is the directory containing `package.json`. Use Node **24** (the `.nvmrc` and CI baseline) and npm. The library's existing supported engine range is unchanged; the development baseline is deliberately narrower.

```sh
nvm install
npm ci
npm run setup:browsers
npm run dev
```

`nvm` is optional; any Node version manager can select 24. `setup:browsers` installs the lockfile-resolved Playwright browsers and their OS dependencies; on Linux this can request sudo. It is a developer setup command, not an end-user requirement. Do not install different browser versions globally.

Open **http://127.0.0.1:4173**. Port **4174** is the separate local protocol fixture. Stop an existing server before starting tests on those ports. Do not substitute `localhost` or automatically adopt preview URLs: callbacks and Origin checks deliberately match exactly.

The app does not load `.env` automatically. `.env.example` documents names only; configure authorized values through the process/secret manager or native session Environment UI. Never copy credentials into templates, chat, commit messages or test diagnostics. Local startup creates encrypted `.ceremony/` state; its key and database must be retained together. Do not point deterministic tests at live service configuration.

### Local protocol fixtures

Open `/?mode=test` only for the explicit developer harness. These synthetic values belong to the local provider on port 4174; never enter real credentials there or use this provider as deployed identity.

| Method                                           | Fixture values                       |
| ------------------------------------------------ | ------------------------------------ |
| API key / personal token                         | `demo-api-key`                       |
| Jira Basic (email / API token)                   | `demo@example.com` / `ceremony-demo` |
| Forms, OAuth approval, device approval, claiming | `demo@example.com` / `ceremony-demo` |

The Neon claiming fixture opens a local provider page where you choose **Demo organization**. It does not request an account email in the ceremony or provision a real database. Provider-backed operation support remains separate from these [service simulations](service-examples.md).

## Devcontainer

Open this repository with a Dev Containers-compatible editor and choose **Reopen in Container**. Docker (or a compatible configured container engine) is a host prerequisite; no hosted service is provisioned. The pinned [official Node image](https://github.com/devcontainers/images/blob/main/src/javascript-node/history/4.0.3.md) runs as the non-root `node` user with the workspace at `/workspaces/ceremony`.

The [container configuration](../.devcontainer/devcontainer.json) runs `npm ci` and browser setup once after creation, then waits for you to start the app or tests. It does not start Impeccable, log in to providers, mount a Docker socket, explicitly forward credential environment variables or create a production database. The embedded PostgreSQL fixtures need no additional database container.

Ports 4173 and 4174 are forwarded at the same local numbers; other ports are not automatically forwarded. Use desktop forwarding to the exact loopback URL above. A cloud editor's browser preview URL is **not** an approved production callback origin. Keep any forwarded ports private. Production HTTPS/OIDC setup remains an explicit [deployment](production-deployment.md) task.

The workspace is bind-mounted: existing `.env` and `.ceremony/` files are visible to the trusted development container, not excluded by `.gitignore`. Use a clean checkout for isolated testing. Editor-managed Git/SSH credential forwarding is also an editor/host policy; this container is not a secret-isolation sandbox. No workspace content is copied into an image by this configuration.

Run `npm ci` when switching between host and container environments so native modules are rebuilt for the current platform; do not use both installations concurrently. No global npm security settings are overwritten. If dependency lifecycle scripts are disabled by host policy, follow the scoped embedded-PostgreSQL hydration procedure in [testing](testing.md) rather than enabling all scripts globally.

CI uses the maintained [Dev Containers action](https://github.com/devcontainers/ci/blob/main/docs/github-action.md) to exercise setup, type checking and integration tests inside this same container; it never pushes an image. A JSON/config test is not a substitute for that Docker execution.

## Root layout and generated files

Root files are intentionally limited to onboarding/product/design documents, package metadata, version/editor settings and auto-discovered tool configs. `PRODUCT.md` and `DESIGN.md` stay at the root for design-tool discovery. Do not move Vite, Nitro, Playwright or Workflow config just to hide it; paths are verified by actual builds. Detailed guides and immutable evidence live under `docs/`; runtime ownership is mapped in [architecture](architecture.md).

| Path                                                                      | Lifecycle                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/`, `examples/`, `hosted/`, `tests/`, `scripts/`, `docs/`             | Tracked source and reviewed documentation                                               |
| `dist/`, `web-dist/`, `.output/`, `.nitro/`, `.swc/`, `.workflow-vitest/` | Rebuildable output; `npm run clean` previews this exact allowlist                       |
| `.ceremony/`, `.workflow-data/`, `.env*`                                  | Protected local state/configuration; never build cleanup targets                        |
| `artifacts/`, `test-results/`, `playwright-report/`                       | Verification/diagnostic evidence with its own retention; not build cleanup targets      |
| `node_modules/`                                                           | Local dependencies; reinstall with `npm ci`, not a broad repository wipe                |
| `.git/`, `.agents/`, `.codex/`, `.impeccable/`, `.serena/`                | Repository/tool-owned metadata; preserve unless its owner explicitly authorizes cleanup |

```sh
npm run clean        # preview only
npm run clean:apply  # after stopping builds/hosted servers: remove only listed outputs
npm run build
npm run build:hosted
```

Cleanup refuses unknown arguments, symlinked outputs and non-directory outputs before removing anything. It does not delete state, evidence, dependencies, branches or worktrees. Deleted build output is regenerated with the build commands; no cleanup command claims to reset provider grants or recover a lost vault key. Do not run it concurrently with a build, Workflow test or hosted server.

## Verification and troubleshooting

Run `npm run verify` from a clean Git checkout for commit-bound evidence. Focused commands and external gates are in [testing](testing.md); publication/deployment remain separate from local setup. Reserved ports, a missing browser binary, a missing native PostgreSQL library, or absent Docker must be reported as the actual failure—not as passing skipped coverage. Restricted environments can use `PLAYWRIGHT_BROWSERS_PATH` consistently for installation and execution.

When the workspace's Git metadata is managed/read-only, use the environment's normal checkout/worktree mechanism. Never replace `.git`, recursively clean the workspace root, or copy `.env`/vault/browser profiles into a delivery clone. Preserve active and unmerged work before any filesystem cleanup.
