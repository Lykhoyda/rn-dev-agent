import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/startup-integrity.js
import { createHash } from "node:crypto";
var STARTUP_INTEGRITY_SYMBOL = "rn-dev-agent.startup-integrity";
function sourceBytes(source) {
  if (typeof source === "string")
    return Buffer.from(source);
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  }
  return Buffer.from(source);
}
function instrumentStartupSource(entrypointUrl2, source) {
  const bytes = sourceBytes(source);
  const attestation = {
    entrypointUrl: entrypointUrl2,
    coreBundleSha256: createHash("sha256").update(bytes).digest("hex")
  };
  const statement = `Object.defineProperty(globalThis,Symbol.for(${JSON.stringify(STARTUP_INTEGRITY_SYMBOL)}),{value:Object.freeze(${JSON.stringify(attestation)}),configurable:false,enumerable:false,writable:false});
`;
  const text = bytes.toString("utf8");
  const newline = text.indexOf("\n");
  const instrumented = text.startsWith("#!") && newline >= 0 ? `${text.slice(0, newline + 1)}${statement}${text.slice(newline + 1)}` : `${statement}${text}`;
  return { source: instrumented, attestation };
}

// packages/rn-dev-agent-core/dist/startup-integrity-loader.js
var entrypointUrl = null;
function initialize(data) {
  const value = data;
  if (!value || typeof value.entrypointUrl !== "string" || !value.entrypointUrl.startsWith("file:")) {
    throw new Error("STARTUP_INTEGRITY_UNAVAILABLE: worker entrypoint URL is invalid");
  }
  entrypointUrl = value.entrypointUrl;
}
async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== entrypointUrl)
    return result;
  if (result.source === null || result.source === void 0 || result.format !== "module") {
    throw new Error("STARTUP_INTEGRITY_UNAVAILABLE: worker entrypoint source is unavailable");
  }
  const instrumented = instrumentStartupSource(url, result.source);
  return {
    ...result,
    source: instrumented.source,
    shortCircuit: true
  };
}
export {
  initialize,
  load
};
