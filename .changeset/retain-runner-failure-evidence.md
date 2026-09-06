---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Retain a bounded closed-vocabulary projection of runner failure evidence on `maestro_run` results and `cdp_run_action` RunRecords before the temporary report tree is deleted, withholding text, images, terminal output and original artifacts.
