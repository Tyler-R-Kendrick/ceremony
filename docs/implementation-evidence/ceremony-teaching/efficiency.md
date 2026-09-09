# Measured efficiency boundary

The preserved `db46b2d06f62b72316d8e46c4a87cc22967590ad` checkout was installed from its lockfile and built with the same Node/Vite toolchain. Its emitted JavaScript assets total **422,659 bytes raw / 132,056 bytes gzip**. The teaching build measured **446,436 / 138,784 bytes** before the final hardening snapshot: +5.6% raw / +5.1% gzip. Gzip uses Node `zlib.gzipSync`, not a network transfer estimate.

`scripts/check-bundle.mjs` measures every final build and writes `artifacts/bundle/size.json`. The project-specific budget is 465,000 raw / 145,000 gzip bytes, approximately ten percent above that measured baseline. A failing budget is a build failure, not a warning. Packed consumer tests separately check framework-neutral imports, React/Vue rendering ownership, optional teaching styles, SSR and absence of server runtime code in browser output.

Semantic budgets are enforced and tested at the durable service: at most eight requested tools per turn (failed calls included), sixteen model invocations and sixty-four tools per connection, and two authoring attempts. Reviewed deterministic recipes require zero model calls. Human waits reserve no inference; status/SSE reconnects perform no provider effects. Browser tests assert provider conversion counters, independently authored fragment reuse and continuation deduplication rather than a fixed number of human consent screens.

These measurements are local evidence, not real-provider latency, model quality, or deployed-platform certification. Final exact-commit build and test results supersede the pre-hardening size observation above.
