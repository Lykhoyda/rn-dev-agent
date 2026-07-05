---
'rn-dev-agent-cdp': patch
'rn-dev-agent-plugin': patch
---

Harden the Android **raw** screenshot capture path (`device_screenshot`, GH #428),
mirroring the iOS hardening from #427:

- **Truncate-before-success**: raw capture now stages `adb exec-out screencap`
  bytes in a unique sibling temp file and `renameSync`s onto the caller's path
  only after both the write stream drains and adb exits 0. A failed or timed-out
  capture can no longer truncate-then-delete an existing file the tool never
  created.
- **Multi-emulator first-pick**: with several emulators booted and no session
  binding, resolution now refuses (exactly-one-or-null via `resolveAndroidEmu`)
  instead of silently grabbing the first emulator — matching iOS
  exactly-one-or-refuse. Sessions still bind to their device id.
- **adb child leak on stream error**: a write-stream error (ENOSPC/EACCES) now
  unpipes and kills the `adb` child before settling, instead of leaving it
  running blocked on stdout.
