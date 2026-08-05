---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Keep the adb serial as Android authority while translating it to Expo's uniquely verified model or AVD display name only at the Expo CLI boundary. Refuse missing, unauthorized, duplicate, foreign, or drifted mappings before Expo starts, pin Expo's adb work with `ANDROID_SERIAL`, and preserve serial-bound build completion and abort behavior.
