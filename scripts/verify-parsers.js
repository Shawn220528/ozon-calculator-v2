const path = require("node:path");
const Papa = require("papaparse");
const { loadTsModule } = require("./ts-module-loader");

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

const {
  parseBatchInput,
} = loadTsModule(path.join("lib", "batch-parsing.ts"));

const {
  parseAlternativeShippingRows,
} = loadTsModule(path.join("lib", "shipping-alternative-parsing.ts"));

const {
  getBatchTemplateCsv,
  getCommissionTemplateCsv,
  getShippingTemplateCsv,
} = loadTsModule(path.join("lib", "template-export.ts"));

const {
  calculateOzonBackendPricing,
} = loadTsModule(path.join("lib", "ozon-pricing.ts"));

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

function assertCsvRowsAligned(csvContent, label) {
  const parsed = Papa.parse(csvContent, {
    header: false,
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) {
    throw new Error(`${label} CSV parse errors: ${parsed.errors.map((error) => error.message).join("; ")}`);
  }
  const rows = parsed.data;
  const headerLength = rows[0].length;
  rows.forEach((row, index) => {
    assertEqual(row.length, headerLength, `${label} row ${index + 1} column count`);
  });
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

const batchCsv = [
  "SKU,一级类目,二级类目,长度,宽度,高度,重量,采购成本,前台售价",
  'A1,家居与汽车用品,"装饰、清洁与储物",20,15,10,300,"12,50",125',
].join("\r\n");
const batchResult = parseBatchInput(batchCsv);
assertDeepEqual(batchResult.errors, [], "batch CSV should parse quoted comma cells");
assertDeepEqual(
  batchResult.rows[0],
  {
    sku: "A1",
    primaryCategory: "家居与汽车用品",
    secondaryCategory: "装饰、清洁与储物",
    length: 20,
    width: 15,
    height: 10,
    weight: 300,
    purchaseCost: 12.5,
    targetPriceRMB: 125,
  },
  "batch CSV row parsing"
);

const incompleteBatch = parseBatchInput([
  "SKU,一级类目,二级类目,重量,目标售价",
  "MISS1,电子产品,手机配件,,abc",
].join("\n"));
assertEqual(incompleteBatch.rows.length, 1, "incomplete batch row should still be visible for diagnostics");
assertEqual(incompleteBatch.errors.length, 1, "incomplete batch row should report missing core fields");

assertCsvRowsAligned(getCommissionTemplateCsv(), "commission template");
assertCsvRowsAligned(getShippingTemplateCsv(), "shipping template");
assertCsvRowsAligned(getBatchTemplateCsv(), "batch template");
const batchTemplateResult = parseBatchInput(getBatchTemplateCsv());
assertDeepEqual(batchTemplateResult.errors, [], "batch template should parse without errors");
assertEqual(batchTemplateResult.rows.length, 3, "batch template sample row count");
assertEqual(batchTemplateResult.rows[0].targetPriceRMB, 125, "batch template target price");

assertDeepEqual(
  calculateOzonBackendPricing(125, 12),
  {
    isValid: true,
    frontPriceRMB: 125,
    frontPriceRUB: 1500,
    ozonBackendPriceRMB: 312.5,
    ozonBackendPriceRUB: 3750,
    ozonOriginalPriceRMB: 520.83,
    ozonOriginalPriceRUB: 6250,
  },
  "Ozon backend pricing"
);
assertEqual(calculateOzonBackendPricing(0, 12).isValid, false, "Ozon pricing invalid without price");
assertEqual(calculateOzonBackendPricing(125, 0).isValid, false, "Ozon pricing invalid without rate");

const alternativeShipping = parseAlternativeShippingRows([
  ["Лого", "Метод", "Рейтинг Ozon", "Сроки доставки", "ПВЗ", "Курьер", "Батарейки"],
  ["", "Test Standard", "4.8", "2026/5/14", "¥2,6 + ¥0,035/1g", "", "Разрешено", "", "", ""],
])[0];
assertEqual(alternativeShipping.deliveryTimeMin, 5, "alternative shipping date min");
assertEqual(alternativeShipping.deliveryTimeMax, 14, "alternative shipping date max");
assertDeepEqual(
  {
    fixFee: alternativeShipping.fixFee,
    varFeePerGram: alternativeShipping.varFeePerGram,
    maxValue: alternativeShipping.maxValue,
    maxValueRUB: alternativeShipping.maxValueRUB,
  },
  { fixFee: 2.6, varFeePerGram: 0.035 },
  "alternative shipping should not create fake value limits"
);

console.log("Parser verification passed.");
