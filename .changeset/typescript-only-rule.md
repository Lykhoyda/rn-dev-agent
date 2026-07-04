---
"rn-dev-agent-plugin": patch
---

Engineering rule: all new code must be TypeScript. CI gains a typescript-only gate (`scripts/check-typescript-only.sh`) that fails when a `.js`/`.mjs`/`.cjs` file appears outside the grandfathered baseline (`scripts/js-migration-baseline.txt`, 344 pre-rule files slated for migration). Shrinking the baseline (migrating to TS) passes automatically; growing it requires an explicit, reviewable baseline edit.
