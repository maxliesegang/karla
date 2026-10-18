import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        !specifier.startsWith(".") ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ERR_MODULE_NOT_FOUND"
      )
        throw error;
      return nextResolve(`${specifier}.tsx`, context);
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { code, errors } = transformSync(fileName, readFileSync(fileName, "utf8"), {
      jsx: { runtime: "automatic" },
    });
    if (errors.length > 0) throw new Error(`${fileName}: ${errors[0].message}`);
    return { format: "module", source: code, shortCircuit: true };
  },
});
