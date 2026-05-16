const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "lib", "logistics-parsing.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
});

const sandbox = {
  exports: {},
  module: { exports: {} },
  require,
  console,
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(output.outputText, sandbox, { filename: sourcePath });

const {
  normalizeLimitValue,
  parseDeliveryTime,
  parseShippingRateString,
  parseValueRange,
} = sandbox.module.exports;

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}\nexpected ${e}\nactual   ${a}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}\nexpected ${expected}\nactual   ${actual}`);
  }
}

[
  ["5-14", { min: 5, max: 14, normalizedFromDate: false }],
  ["5月14日", { min: 5, max: 14, normalizedFromDate: true }],
  ["2026/5/14", { min: 5, max: 14, normalizedFromDate: true }],
  ["2026-05-14", { min: 5, max: 14, normalizedFromDate: true }],
  ["5/14/2026", { min: 5, max: 14, normalizedFromDate: true }],
  ["17-29", { min: 17, max: 29, normalizedFromDate: false }],
].forEach(([input, expected]) => {
  assertDeepEqual(parseDeliveryTime(input), expected, `delivery time: ${input}`);
});

assertDeepEqual(parseValueRange("0.01 - 135"), { min: 0.01, max: 135, hasLimit: true }, "RMB value range");
assertDeepEqual(parseValueRange("1 - 1500"), { min: 1, max: 1500, hasLimit: true }, "RUB value range");
assertDeepEqual(parseValueRange("-"), { min: 0, max: 0, hasLimit: false }, "empty value range");
assertEqual(normalizeLimitValue(999999), undefined, "999999 should mean no limit");

assertDeepEqual(
  parseShippingRateString("¥3.12 + ¥0.0468/1 g"),
  { fixFee: 3.12, varFeePerGram: 0.0468 },
  "shipping rate dot decimal"
);
assertDeepEqual(
  parseShippingRateString("¥2,6 + ¥0,035/1g"),
  { fixFee: 2.6, varFeePerGram: 0.035 },
  "shipping rate comma decimal"
);

console.log("Parser verification passed.");

