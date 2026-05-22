const path = require("node:path");
const fs = require("node:fs");
const Papa = require("papaparse");
const XLSX = require("xlsx");
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
  parseCommissionWorkbookRows,
  parseCommissionRows,
  selectCommissionSheetName,
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

const {
  calculateSuggestedPrice,
  calculateCpcCost,
  performFullCalculation,
  reversePriceFromMargin,
} = loadTsModule(path.join("lib", "calculator.ts"));

const {
  parseEuropeanNumber,
} = loadTsModule(path.join("lib", "number-parsing.ts"));

const {
  buildColumnMapping,
} = loadTsModule(path.join("lib", "constants.ts"));

const {
  smartParseCSV,
} = loadTsModule(path.join("lib", "smart-parser.ts"));

const {
  isSkippableShippingRow,
  selectShippingSheetName,
} = loadTsModule(path.join("lib", "shipping-workbook.ts"));

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

function assertApproxEqual(actual, expected, label, epsilon = 0.000001) {
  if (Math.abs(actual - expected) > epsilon) {
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

function assertSmartShippingWorkbookMapping(workbookPath, label) {
  if (!fs.existsSync(workbookPath)) {
    return;
  }

  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const sheetName = selectShippingSheetName(workbook.SheetNames);
  if (!["中国 rFBS", "CHINA rFBS"].includes(sheetName)) {
    throw new Error(`${label} selected unexpected sheet: ${sheetName}`);
  }

  const csvContent = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
  if (csvContent.includes("[Content_Types].xml") || /^PK/.test(csvContent.trim())) {
    throw new Error(`${label} should convert XLSX worksheet content, not zip binary text`);
  }

  const parsed = smartParseCSV(csvContent, "shipping");
  assertEqual(parsed.errors.length, 0, `${label} smart parse errors`);

  const requiredFields = ["serviceTier", "serviceLevel", "thirdParty", "name", "rate"];
  const interceptorFields = [
    "deliveryTime",
    "minWeight",
    "maxWeight",
    "dimension",
    "valueRUB",
    "valueRMB",
    "battery",
    "liquid",
  ];

  [...requiredFields, ...interceptorFields].forEach((field) => {
    const mapping = parsed.mappings.find((item) => item.systemField === field);
    if (!mapping || mapping.columnIndex < 0) {
      throw new Error(`${label} missing smart mapping for ${field}`);
    }
  });

  assertEqual(parsed.recognizedCount, parsed.totalCount, `${label} should recognize every logistics field`);
  const previewText = parsed.rows.slice(0, 5).flat().join(" | ");
  if (!/ATC Express Extra Small|GUOO Express Extra Small/.test(previewText)) {
    throw new Error(`${label} preview should contain real shipping rows`);
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
assertEqual(parseEuropeanNumber("30,000"), 30000, "comma thousands number");
assertEqual(parseEuropeanNumber("30 000"), 30000, "space thousands number");
assertEqual(parseEuropeanNumber("30,000.5"), 30000.5, "comma thousands with dot decimal number");
assertEqual(parseEuropeanNumber("0,03432"), 0.03432, "comma decimal number");
assertEqual(parseEuropeanNumber("2,6"), 2.6, "single comma decimal number");
assertEqual(parseEuropeanNumber("30.5"), 30.5, "dot decimal number");
assertApproxEqual(calculateCpcCost(true, 10, 5, 10, "bidCvr", 0, 200), 20, "CPC bid/CVR mode remains unchanged");
assertApproxEqual(calculateCpcCost(true, 10, 5, 10, "salesPercent", 7, 200), 14, "CPC sales percent mode");
assertApproxEqual(calculateCpcCost(false, 10, 5, 10, "salesPercent", 7, 200), 0, "disabled CPC has no cost");

const baseSuggestionInput = {
  primaryCategory: "测试一级",
  secondaryCategory: "测试二级",
  length: 10,
  width: 10,
  height: 10,
  weight: 100,
  hasBattery: false,
  hasLiquid: false,
  designatedProviders: [],
  purchaseCost: 30,
  domesticShipping: 3,
  packagingFee: 2,
  returnRate: 0,
  returnHandling: "destroy",
  cpaEnabled: false,
  cpaRate: 0,
  cpcEnabled: false,
  cpcBillingMode: "bidCvr",
  cpcBid: 0,
  cpcConversionRate: 0,
  cpcSalesPercent: 0,
  targetPriceRMB: 0,
  promotionDiscount: 0,
  exchangeRate: 12,
  withdrawalFee: 1.5,
  paymentFee: 1,
  exchangeRateBuffer: 0,
  valueLimitCurrency: "RMB",
  fulfillmentMode: "RFBS",
  rivalPrice: 0,
  rivalCurrency: "RMB",
  multiItemCount: 1,
  taxEnabled: false,
  vatRate: 0,
  corporateTaxRate: 0,
};

const baseSuggestionChannel = {
  id: "suggestion-1",
  name: "测试物流 Extra Small",
  thirdParty: "TEST",
  serviceTier: "Extra Small",
  serviceLevel: "Express",
  fixFee: 5,
  varFeePerGram: 0.02,
  pricePerKg: 25,
  pricePerCubic: 0,
  minWeight: 1,
  maxWeight: 1000,
  maxLength: 60,
  maxWidth: 60,
  maxHeight: 60,
  maxSumDimension: 150,
  deliveryTimeMin: 5,
  deliveryTimeMax: 14,
  deliveryTime: 10,
  minValueRUB: 120,
  maxValueRUB: 5000,
  minValue: 10,
  maxValue: 500,
  billingType: "实际重量",
  volumetricDivisor: 0,
  ozonRating: 0,
  batteryAllowed: true,
  liquidAllowed: true,
  reason: "货值不足",
  interceptionReasons: [{ dimension: "货值", code: "VALUE_TOO_LOW", message: "货值不足" }],
};

const suggestionCommission = {
  primaryCategory: "测试一级",
  secondaryCategory: "测试二级",
  tiers: [
    { min: 0, max: 1500, rate: 10 },
    { min: 1500.01, max: 5000, rate: 15 },
    { min: 5000.01, max: Infinity, rate: 20 },
  ],
};

const fallbackSuggestion = calculateSuggestedPrice([baseSuggestionChannel], 12, "RMB");
assertEqual(fallbackSuggestion.suggestedPriceRMB, 10, "suggested price falls back to logistics threshold without commission");
assertEqual(fallbackSuggestion.reason, "logistics-threshold", "fallback suggestion reason");

const profitReverse = reversePriceFromMargin(20, { ...baseSuggestionInput, targetPriceRMB: 100 }, suggestionCommission, baseSuggestionChannel);
const profitSuggestion = calculateSuggestedPrice([baseSuggestionChannel], 12, "RMB", baseSuggestionInput, suggestionCommission, 20);
if (profitSuggestion.suggestedPriceRMB < Math.ceil(profitReverse.priceRMB)) {
  throw new Error(`suggested price should satisfy 20% margin\nexpected >= ${Math.ceil(profitReverse.priceRMB)}\nactual   ${profitSuggestion.suggestedPriceRMB}`);
}
if (profitSuggestion.suggestedPriceRMB < fallbackSuggestion.suggestedPriceRMB) {
  throw new Error("suggested price should not be below logistics threshold");
}
assertEqual(profitSuggestion.reason, "profit-target", "profit-aware suggestion reason");
assertEqual(profitSuggestion.targetMargin, 20, "profit-aware suggestion target margin");

const rubLimitSuggestion = calculateSuggestedPrice(
  [{ ...baseSuggestionChannel, minValueRUB: 240, minValue: 5 }],
  12,
  "RUB"
);
assertEqual(rubLimitSuggestion.suggestedPriceRMB, 20, "RUB value-limit suggestion should use RUB threshold");

const paymentFeeBaseResult = performFullCalculation(
  { ...baseSuggestionInput, targetPriceRMB: 100, withdrawalFee: 0, paymentFee: 0 },
  suggestionCommission,
  undefined
);
const paymentFeeResult = performFullCalculation(
  { ...baseSuggestionInput, targetPriceRMB: 100, withdrawalFee: 0, paymentFee: 1 },
  suggestionCommission,
  undefined
);
assertEqual(paymentFeeResult.costs.paymentFee, 1, "payment fee cost should equal 1% of price");
assertEqual(
  Number((paymentFeeBaseResult.netProfit - paymentFeeResult.netProfit).toFixed(2)),
  1,
  "payment fee should reduce net profit by 1% of price"
);

const cpcSalesPercentResult = performFullCalculation(
  {
    ...baseSuggestionInput,
    targetPriceRMB: 200,
    cpcEnabled: true,
    cpcBillingMode: "salesPercent",
    cpcSalesPercent: 7,
    cpaEnabled: true,
    cpaRate: 3,
  },
  suggestionCommission,
  baseSuggestionChannel
);
assertApproxEqual(cpcSalesPercentResult.costs.cpcCost, 14, "full calculation uses CPC sales percent cost");
assertApproxEqual(cpcSalesPercentResult.adRiskControl.currentACOS, 10, "ACOS includes CPC sales percent and CPA");

const modeCommission = {
  ...suggestionCommission,
  modeTiers: {
    RFBS: [
      { min: 0, max: 1500, rate: 12 },
      { min: 1500.01, max: 5000, rate: 14 },
      { min: 5000.01, max: Infinity, rate: 18 },
    ],
    FBP: [
      { min: 0, max: 1500, rate: 6 },
      { min: 1500.01, max: 5000, rate: 7 },
      { min: 5000.01, max: Infinity, rate: 8 },
    ],
  },
};
const rfbsModeResult = performFullCalculation({ ...baseSuggestionInput, targetPriceRMB: 100, fulfillmentMode: "RFBS" }, modeCommission, baseSuggestionChannel);
const fbpModeResult = performFullCalculation({ ...baseSuggestionInput, targetPriceRMB: 100, fulfillmentMode: "FBP" }, modeCommission, baseSuggestionChannel);
assertEqual(rfbsModeResult.commissionRate, 12, "RFBS mode should use RFBS commission tiers");
assertEqual(fbpModeResult.commissionRate, 6, "FBP mode should use FBP commission tiers");
if (fbpModeResult.netProfit <= rfbsModeResult.netProfit) {
  throw new Error("FBP lower commission should improve net profit in mode regression");
}

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
    categoryPath: ["测试一级", "测试二级"],
    tiers: [
      { min: 0, max: 1500, rate: 11 },
      { min: 1500.01, max: 5000, rate: 14 },
      { min: 5000.01, max: null, rate: 21 },
    ],
    modeTiers: {
      RFBS: [
        { min: 0, max: 1500, rate: 11 },
        { min: 1500.01, max: 5000, rate: 14 },
        { min: 5000.01, max: null, rate: 21 },
      ],
      FBP: [
        { min: 0, max: 1500, rate: 11 },
        { min: 1500.01, max: 5000, rate: 14 },
        { min: 5000.01, max: null, rate: 21 },
      ],
    },
  },
  "commission template parsing"
);

const officialCommissionPath = "E:\\Download\\Microsoft Edgedownload\\Tarifs_CN_01_12_2025_1761720496 (1).xlsx";
if (fs.existsSync(officialCommissionPath)) {
  const officialWorkbook = XLSX.readFile(officialCommissionPath, { raw: false, cellDates: false });
  const officialSheetName = selectCommissionSheetName(officialWorkbook.SheetNames);
  assertEqual(officialSheetName, "Full ChinaHK", "official tarifs workbook sheet selection");
  const officialRows = XLSX.utils.sheet_to_json(officialWorkbook.Sheets[officialSheetName], { header: 1, defval: "", raw: false, blankrows: false });
  const officialCommissions = parseCommissionWorkbookRows(officialRows, officialSheetName);
  if (officialCommissions.length < 10000) {
    throw new Error(`official tarifs parser should return detailed rows\nexpected >= 10000\nactual   ${officialCommissions.length}`);
  }
  const biopsyPunch = officialCommissions.find((item) =>
    item.primaryCategory === "药店" &&
    item.secondaryCategory === "医疗器械" &&
    (item.tertiaryCategory || "").includes("穿孔活检工具")
  );
  if (!biopsyPunch) {
    throw new Error("official tarifs parser should include 药店 / 医疗器械 / 穿孔活检工具");
  }
  assertDeepEqual(
    biopsyPunch.categoryPath,
    ["药店", "医疗器械", biopsyPunch.tertiaryCategory],
    "official tarifs category path"
  );
  assertDeepEqual(
    biopsyPunch.modeTiers.RFBS.map((tier) => tier.rate),
    [12, 14, 18],
    "official tarifs RFBS rates"
  );
  assertDeepEqual(
    biopsyPunch.modeTiers.FBP.map((tier) => tier.rate),
    [11, 13, 17],
    "official tarifs FBP rates"
  );
  if (!officialCommissions.some((item) => item.sourceMeta?.brand === "Apple")) {
    throw new Error("official tarifs parser should preserve Apple brand rows");
  }
  const primaryNames = officialCommissions.map((item) => item.primaryCategory);
  if (primaryNames.some((name) => !name)) {
    throw new Error("official tarifs parser should not emit empty primary categories");
  }
  if (!officialCommissions.some((item) => item.tertiaryCategory && item.categoryPath?.length === 3)) {
    throw new Error("official tarifs parser should emit third-level categories");
  }
}

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

const newShippingWorkbook = "E:\\CodexProjects\\China_scoring_ENG_CN_20_05_2026_1779193810.xlsx";
if (fs.existsSync(newShippingWorkbook)) {
  const workbook = XLSX.readFile(newShippingWorkbook, { cellDates: false });
  assertEqual(selectShippingSheetName(workbook.SheetNames), "中国 rFBS", "new shipping workbook sheet selection");

  const englishRows = XLSX.utils.sheet_to_json(workbook.Sheets["CHINA rFBS"], { header: 1, defval: "", raw: false });
  assertDeepEqual(
    buildColumnMapping(englishRows[4]),
    {
      serviceTier: 0,
      serviceLevel: 1,
      thirdParty: 2,
      name: 3,
      rating: 4,
      deliveryTime: 5,
      rate: 6,
      battery: 7,
      liquid: 8,
      dimension: 9,
      minWeight: 10,
      maxWeight: 11,
      valueRUB: 12,
      valueRMB: 13,
      billingType: 16,
      volumetricDivisor: 17,
    },
    "new English shipping headers"
  );
  assertEqual(isSkippableShippingRow(englishRows[11], "переход"), true, "transition rows should be skipped");
}

function assertFirstBudgetWeight(workbookPath, label) {
  if (!fs.existsSync(workbookPath)) {
    return;
  }

  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const sheetName = selectShippingSheetName(workbook.SheetNames);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
  const budgetRow = rows.find((row) => String(row[0]).trim() === "Budget");
  if (!budgetRow) {
    throw new Error(`${label} missing Budget row`);
  }

  assertEqual(parseEuropeanNumber(budgetRow[10]), 501, `${label} Budget min weight`);
  assertEqual(parseEuropeanNumber(budgetRow[11]), 30000, `${label} Budget max weight`);
}

assertSmartShippingWorkbookMapping(
  "E:\\CodexProjects\\China_scoring_ENG_CN_20_05_2026_1779193810.xlsx",
  "new shipping workbook smart mapping"
);
assertFirstBudgetWeight(
  "E:\\CodexProjects\\China_scoring_ENG_CN_20_05_2026_1779193810.xlsx",
  "new shipping workbook"
);
assertSmartShippingWorkbookMapping(
  "E:\\OpenCode\\ozon-rfbs-calculator\\China_scoring_ENG_CN_20_05_2026_1779193810.xlsx",
  "uploaded shipping workbook smart mapping"
);
assertFirstBudgetWeight(
  "E:\\OpenCode\\ozon-rfbs-calculator\\China_scoring_ENG_CN_20_05_2026_1779193810.xlsx",
  "uploaded shipping workbook"
);

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
