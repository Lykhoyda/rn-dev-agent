---
"rn-dev-agent": minor
---

Android `rn-android-runner` now self-installs on first use (parity with the iOS `rn-fast-runner` cold build): `startAndroidRunner` installs the prebuilt APKs — and cold-builds them via Gradle if absent — when the instrumentation isn't on the device yet. No external CLI or manual `gradlew + adb install` step is required; this makes the `/setup` and `/doctor` "builds/installs on first use" promise true on Android.
