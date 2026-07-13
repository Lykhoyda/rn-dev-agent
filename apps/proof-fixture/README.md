# Proof fixture

This private Expo app is the canonical runtime target for strict factory proof.

From the repository root:

```bash
corepack yarn install --immutable
corepack yarn workspace rn-dev-agent-proof-fixture ios
corepack yarn workspace rn-dev-agent-proof-fixture start
```

Bundle ID: **dev.lykhoyda.rndevagent.proof**.
Copy **actions/canonical-proof.yaml** into the fixture project's
**.rn-agent/actions/** when exercising learned-action discovery.
