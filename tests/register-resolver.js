/**
 * Resolves the app's extensionless imports for the test runner.
 *
 * The source imports its own modules the way the bundler reads them — `./line-families`, with no
 * extension — and Node's ESM resolver requires one. Rather than spell extensions through the app
 * for the sake of its tests, or take on a test runner as a dependency, the missing `.ts` is added
 * back here: a relative specifier that resolves to nothing is retried once with the extension it
 * was written without.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
