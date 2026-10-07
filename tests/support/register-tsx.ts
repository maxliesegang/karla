import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";

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
    const source = transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext },
      fileName: fileURLToPath(url),
    }).outputText;
    return { format: "module", source, shortCircuit: true };
  },
});
