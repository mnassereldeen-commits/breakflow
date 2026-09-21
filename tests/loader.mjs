/* Node module hook: swap the real Firebase wiring for the in-memory fake. */
export async function resolve(specifier, context, nextResolve) {
  if (/(^|\/)firebase\.js$/.test(specifier) && context.parentURL && /assets\/js\/store\.js$/.test(context.parentURL)) {
    return { url: new URL("./fake-firebase.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
