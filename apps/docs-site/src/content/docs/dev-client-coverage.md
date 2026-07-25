---
title: Dev Client picker coverage
description: Current authority-safe guidance for Expo Dev Client targets.
---

The earlier picker incident report described `cdp_status` discovery and
auto-recovery behavior that the fenced-session model has superseded.

Use [Parallel session authority](session-authority/) for the current binding
contract and [Troubleshooting](troubleshooting/#connection) for picker and
connection recovery. `cdp_status` is passive; `rn_session`, `cdp_connect`, and
the explicit picker/dev-menu tools own transitions.
