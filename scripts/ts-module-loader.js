const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const moduleCache = new Map();

function loadTsModule(relativePath, fromDir = path.join(__dirname, "..")) {
  const sourcePath = path.resolve(fromDir, relativePath);
  if (moduleCache.has(sourcePath)) {
    return moduleCache.get(sourcePath).exports;
  }

  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });

  const loadedModule = { exports: {} };
  moduleCache.set(sourcePath, loadedModule);

  const localRequire = (request) => {
    if (request.startsWith(".")) {
      let resolved = request;
      if (!/\.(ts|tsx)$/.test(request)) {
        resolved = fs.existsSync(path.resolve(path.dirname(sourcePath), `${request}.ts`))
          ? `${request}.ts`
          : `${request}.tsx`;
      }
      return loadTsModule(resolved, path.dirname(sourcePath));
    }
    return require(request);
  };

  const sandbox = {
    exports: {},
    module: loadedModule,
    require: localRequire,
    console,
  };
  sandbox.exports = loadedModule.exports;
  vm.runInNewContext(output.outputText, sandbox, { filename: sourcePath });
  return loadedModule.exports;
}

module.exports = { loadTsModule };
