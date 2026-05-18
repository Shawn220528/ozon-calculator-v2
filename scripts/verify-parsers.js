const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function loadTsModule(relativePath) {
  const sourcePath = path.join(__dirname, "..", relativePath);
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
  return sandbox.module.exports;
}

const {
  normalizeLimitValue,
  parseDeliveryTime,
  parseShippingRateString,
  parseValueRange,
} = loadTsModule(path.join("lib", "logistics-parsing.ts"));

const {
  findCommissionColumns,
  parseCommissionPercent,
  parseCommissionRows,
} = loadTsModule(path.join("lib", "commission-parsing.ts"));

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

const commissionHeaders = [
  "一级类目",
  "二级类目",
  "佣金率(0-1500卢布)",
  "佣金率(1500-5000卢布)",
  "佣金率(5000+卢布)",
];
assertDeepEqual(
  findCommissionColumns(commissionHeaders),
  { primaryCategory: 0, secondaryCategory: 1, tier1Rate: 2, tier2Rate: 3, tier3Rate: 4 },
  "commission template columns"
);
assertEqual(parseCommissionPercent("0.12"), 12, "fractional commission percent");
assertEqual(parseCommissionPercent("14.00%"), 14, "display commission percent");

const commissionRows = [
  commissionHeaders,
  ["测试一级", "测试二级", "11.00%", "14.00%", "21.00%"],
];
assertDeepEqual(
  parseCommissionRows(commissionRows)[0],
  {
    primaryCategory: "测试一级",
    secondaryCategory: "测试二级",
    tiers: [
      { min: 0, max: 1500, rate: 11 },
      { min: 1500.01, max: 5000, rate: 14 },
      { min: 5000.01, max: null, rate: 21 },
    ],
  },
  "commission template parsing"
);

console.log("Parser verification passed.");
