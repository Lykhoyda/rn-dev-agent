---
'rn-dev-agent-plugin': patch
---

Fix #377: `record_proof.sh convert-gif` now creates the output's parent directory before invoking ffmpeg, so `device_record action=stop gif=true gifPath=<fresh-dir>/clip.gif` with an explicit path into a not-yet-existing directory succeeds instead of failing the ffmpeg write with ENOENT. If the parent cannot be created (e.g. a path component is a regular file), the command fails with an honest error naming the directory instead of a silent ffmpeg exit. Mirrors the `mkdir -p` already done by `cmd_start`/`cmd_stop`; regression-guarded by a PATH-stubbed ffmpeg test in CI.
