// `expected` is the parent recorded at process start; any other parent means the CLI is gone.
export function watchParent(
  expected: number,
  readParent: () => number,
  onGone: () => void,
  everyMs = 1000,
): () => void {
  if (readParent() !== expected) {
    onGone();
    return () => undefined;
  }
  const timer = setInterval(() => {
    if (readParent() === expected) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
