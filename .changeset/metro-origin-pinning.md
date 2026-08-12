---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Pin device sessions to their Metro origin: record the expected Metro port on the device binding and refuse cdp_connect and device_* tools with METRO_ORIGIN_MISMATCH when the bound device's app is proven to be served by a sibling Metro (dev-client fallback), while unprovable origin evidence keeps the existing optional-origin behavior.
