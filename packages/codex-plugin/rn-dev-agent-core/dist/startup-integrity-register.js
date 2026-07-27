import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/startup-integrity-register.js
import { realpathSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
var workerPath = process.argv[1];
if (!workerPath) {
  throw new Error("STARTUP_INTEGRITY_UNAVAILABLE: worker entrypoint is missing");
}
register(new URL("./startup-integrity-loader.js", import.meta.url), {
  parentURL: import.meta.url,
  data: {
    entrypointUrl: pathToFileURL(realpathSync(workerPath)).href
  }
});
