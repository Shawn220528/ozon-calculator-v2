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
  normalizeOzonRating,
  parseAlternativeShippingRows,
} = loadTsModule(path.join("lib", "shipping-alternative-parsing.ts"));

const {
  createShippingChannel,
  parseDimensions,
  parsePriceRange,
  parseVolumetricDivisor,
} = loadTsModule(path.join("lib", "shipping-parser.ts"));

const {
  getBatchTemplateCsv,
  getCommissionTemplateCsv,
  getShippingTemplateCsv,
} = loadTsModule(path.join("lib", "template-export.ts"));

const {
  calculateOzonBackendPricing,
} = loadTsModule(path.join("lib", "ozon-pricing.ts"));

const {
  isProfitMarginBelowThreshold,
} = loadTsModule(path.join("lib", "profit-threshold.ts"));

const {
  calculateSuggestedPrice,
  calculateCpaCost,
  calculateCpcCost,
  calculateExchangeRateStressTest,
  calculateProfitCurve,
  calculateSixTierPricing,
  calculatePricingStrategies,
  calculateMultiItemProfit,
  calculateVolumetricWeight,
  getChargeableWeight,
  calculateReturnCost,
  calculateMarginalContribution,
  calculateNetProfit,
  calculateRequiredPriceRMB,
  calculateROAS,
  calculateBreakEvenROAS,
  calculateBreakEvenACOS,
  calculateCVRsensitivity,
  normalizePromotionDiscount,
  calculateOriginalPrice,
  calculateTaxSimulation,
  detectShippingDimensionLimits,
  detectCommissionBlackHole,
  detectCommissionTierBoundary,
  detectShippingWeightBoundary,
  performFullCalculation,
  getCommissionRate,
  normalizeCommissionPriceRUB,
  reversePriceFromMargin,
} = loadTsModule(path.join("lib", "calculator.ts"));

const {
  parseEuropeanNumber,
} = loadTsModule(path.join("lib", "number-parsing.ts"));

const {
  cnyToRub,
  getRiskAdjustedRevenueRMB,
  getRiskAdjustedRubPerCny,
  normalizeExchangeRateBuffer,
  rubToCny,
} = loadTsModule(path.join("lib", "currency.ts"));

const {
  buildColumnMapping,
} = loadTsModule(path.join("lib", "constants.ts"));

const {
  parseSizeConstraints,
  smartParseCSV,
  validateSizeConstraints,
} = loadTsModule(path.join("lib", "smart-parser.ts"));

const {
  calculateShippingCost,
  evaluateDimensionInterceptions,
  evaluateValueInterceptions,
  evaluateWeightInterceptions,
  evaluateVolumetricWeightInterceptions,
  parseBillingWeight,
} = loadTsModule(path.join("lib", "data-hub-context.tsx"));

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
  ["-5-14", { min: 20, max: 40, normalizedFromDate: false }],
  ["5--14", { min: 20, max: 40, normalizedFromDate: false }],
].forEach(([input, expected]) => {
  assertDeepEqual(parseDeliveryTime(input), expected, `delivery time: ${input}`);
});

assertDeepEqual(parseValueRange("0.01 - 135"), { min: 0.01, max: 135, hasLimit: true }, "RMB value range");
assertDeepEqual(parseValueRange("1 - 1500"), { min: 1, max: 1500, hasLimit: true }, "RUB value range");
assertDeepEqual(parseValueRange("-"), { min: 0, max: 0, hasLimit: false }, "empty value range");
assertDeepEqual(parseValueRange("-10 - 20"), { min: 0, max: 20, hasLimit: true }, "negative range minimum should clamp to zero");
assertDeepEqual(parsePriceRange("-10 - 20"), { min: 0, max: 20 }, "shipping parser price range should clamp negative minimum to zero");
assertDeepEqual(parseDimensions("边长总和 ≤ -90 cm, 长边 ≤ -60 cm"), { maxSum: 0, maxSide: 0 }, "shipping parser dimensions should clamp negative limits to zero");
assertEqual(parseVolumetricDivisor("长 × 宽 × 高 ÷ -12000"), Infinity, "negative volumetric divisor should mean no volumetric divisor");
assertDeepEqual(
  parseSizeConstraints("边长总和 ≤ -90 cm, 长边 ≤ -60 cm"),
  { maxSum: 0, maxLongEdge: 0, rawText: "边长总和 ≤ -90 cm, 长边 ≤ -60 cm" },
  "smart parser size constraints should clamp negative limits to zero"
);
assertDeepEqual(
  parseSizeConstraints("边长总和 ≤ 90,5 cm, 长边 ≤ 60,5 cm"),
  { maxSum: 90.5, maxLongEdge: 60.5, rawText: "边长总和 ≤ 90,5 cm, 长边 ≤ 60,5 cm" },
  "smart parser size constraints should preserve comma decimals"
);
assertEqual(
  validateSizeConstraints(-100, 100, 100, { maxSum: 150, maxLongEdge: null, rawText: "test" }).isValid,
  false,
  "smart parser size validation should not let negative product dimensions bypass sum limits"
);
assertEqual(normalizeLimitValue(999999), undefined, "999999 should mean no limit");
assertEqual(normalizeLimitValue(0), undefined, "zero should mean no value limit");
assertEqual(normalizeLimitValue(-5), undefined, "negative value limit should mean no limit");
assertEqual(parseEuropeanNumber("30,000"), 30000, "comma thousands number");
assertEqual(parseEuropeanNumber("30 000"), 30000, "space thousands number");
assertEqual(parseEuropeanNumber("30,000.5"), 30000.5, "comma thousands with dot decimal number");
assertEqual(parseEuropeanNumber("0,03432"), 0.03432, "comma decimal number");
assertEqual(parseEuropeanNumber("2,6"), 2.6, "single comma decimal number");
assertEqual(parseEuropeanNumber("30.5"), 30.5, "dot decimal number");
assertEqual(normalizeExchangeRateBuffer(-5), 0, "exchange rate buffer should not go below 0%");
assertEqual(normalizeExchangeRateBuffer(150), 100, "exchange rate buffer should be capped at 100%");
assertApproxEqual(getRiskAdjustedRubPerCny(10, 10), 11, "exchange risk buffer should worsen RUB/CNY settlement rate");
assertApproxEqual(getRiskAdjustedRevenueRMB(100, 10), 90.9090909090909, "exchange risk buffer should reduce RMB revenue");
assertApproxEqual(
  cnyToRub(getRiskAdjustedRevenueRMB(100, 10), getRiskAdjustedRubPerCny(10, 10)),
  1000,
  "risk-adjusted revenue and settlement rate should preserve front RUB price"
);
assertApproxEqual(cnyToRub(-100, 12), 0, "negative CNY should not convert to negative RUB");
assertApproxEqual(rubToCny(-1200, 12), 0, "negative RUB should not convert to negative CNY");
assertApproxEqual(getRiskAdjustedRevenueRMB(-100, 10), 0, "negative RMB revenue should not create negative risk-adjusted revenue");
assertApproxEqual(getRiskAdjustedRevenueRMB(Infinity, 10), 0, "infinite RMB revenue should not create infinite risk-adjusted revenue");
assertApproxEqual(calculateCpcCost(true, 10, 5, 10, "bidCvr", 0, 200), 20, "CPC bid/CVR mode remains unchanged");
assertApproxEqual(calculateCpcCost(true, 10, 5, 10, "salesPercent", 7, 200), 14, "CPC sales percent mode");
assertApproxEqual(calculateCpcCost(false, 10, 5, 10, "salesPercent", 7, 200), 0, "disabled CPC has no cost");
assertApproxEqual(calculateCpcCost(true, -10, 5, 10, "bidCvr", 0, 200), 0, "negative CPC bid should not create negative ad cost");
assertApproxEqual(calculateCpcCost(true, Infinity, 5, 10, "bidCvr", 0, 200), 0, "infinite CPC bid should not create infinite ad cost");
assertApproxEqual(calculateCpcCost(true, 10, Infinity, 10, "bidCvr", 0, 200), 0, "infinite CPC CVR should not create ad cost");
assertApproxEqual(calculateCpcCost(true, 10, 150, 10, "bidCvr", 0, 200), 1, "CPC CVR should be capped at 100%");
assertApproxEqual(calculateCpcCost(true, 10, 5, 10, "salesPercent", Infinity, 200), 0, "infinite CPC sales percent should not create infinite ad cost");
assertApproxEqual(calculateCpcCost(true, 10, 5, 10, "salesPercent", 200, 100), 100, "CPC sales percent should cap percentage rate at 100%");
assertApproxEqual(calculateCpcCost(true, 10, 5, 10, "salesPercent", 7, Infinity), 0, "infinite price should not create infinite CPC sales percent cost");
assertApproxEqual(calculateVolumetricWeight(-20, 10, 10), 0, "negative dimensions should not create negative volumetric weight");
assertApproxEqual(calculateVolumetricWeight(20, 10, 10, 0), 0, "zero divisor should not create infinite volumetric weight");
assertDeepEqual(
  getChargeableWeight(-20, 10, 10, -300),
  { volumetric: 0, chargeable: 0, isVolumetric: false },
  "fallback chargeable weight should normalize invalid dimensions and weight"
);

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

const actualWeightBilling = parseBillingWeight(baseSuggestionChannel, 100, 100, 100, 300);
assertEqual(actualWeightBilling.divisor, 0, "volumetric divisor 0 should remain explicit no-volumetric billing");
assertEqual(actualWeightBilling.volumetricWeight, 0, "no-volumetric channel should not synthesize dimensional weight");
assertEqual(actualWeightBilling.billingWeight, 300, "no-volumetric channel should bill by actual weight");
const malformedBilling = parseBillingWeight(
  { ...baseSuggestionChannel, billingType: "取大", volumetricDivisor: 12000 },
  -20,
  10,
  10,
  -300
);
assertEqual(malformedBilling.billingWeight, 0, "negative dimensions and weight should not produce negative billing weight");
assertEqual(malformedBilling.volumetricWeight, 0, "negative dimensions should not produce negative volumetric weight");
assertEqual(
  calculateShippingCost({ ...baseSuggestionChannel, fixFee: -5, varFeePerGram: -0.02 }, -300),
  0,
  "negative logistics fees and weights should not produce negative shipping cost"
);
assertDeepEqual(
  evaluateValueInterceptions(50, 600, { ...baseSuggestionChannel, minValue: 10, maxValue: 500, minValueRUB: 1000, maxValueRUB: 2000 }, "RMB"),
  [],
  "preferred RMB value limits should be used when present"
);
assertDeepEqual(
  evaluateValueInterceptions(50, 600, { ...baseSuggestionChannel, minValue: undefined, maxValue: undefined, minValueRUB: 1000, maxValueRUB: 2000 }, "RMB").map((reason) => reason.code),
  ["VALUE_TOO_LOW"],
  "RMB value mode should fall back to RUB limits only when RMB limits are missing"
);
assertDeepEqual(
  evaluateValueInterceptions(5000, 60000, { ...baseSuggestionChannel, minValue: 0, maxValue: 999999, minValueRUB: 0, maxValueRUB: 999999 }, "RMB"),
  [],
  "zero lower bound and sentinel upper bound should not block value"
);
assertDeepEqual(
  evaluateValueInterceptions(Infinity, Infinity, { ...baseSuggestionChannel, minValue: undefined, maxValue: 500 }, "RMB"),
  [],
  "infinite prices should normalize to zero before value upper-limit interception"
);
assertDeepEqual(
  evaluateValueInterceptions(-100, -1200, { ...baseSuggestionChannel, minValue: 10, maxValue: 500 }, "RMB").map((reason) => reason.code),
  ["VALUE_TOO_LOW"],
  "negative prices should normalize to zero before value lower-limit interception"
);
assertDeepEqual(
  evaluateWeightInterceptions(5, { ...baseSuggestionChannel, minWeight: 10, maxWeight: 1000 }, { minWeight: false, maxWeight: true }),
  [],
  "disabled min weight interception should not block below-min packages"
);
assertDeepEqual(
  evaluateWeightInterceptions(1200, { ...baseSuggestionChannel, minWeight: 10, maxWeight: 1000 }, { minWeight: false, maxWeight: true }).map((reason) => reason.code),
  ["WEIGHT_TOO_HIGH"],
  "enabled max weight interception should still block above-max packages"
);
assertDeepEqual(
  evaluateWeightInterceptions(5, { ...baseSuggestionChannel, minWeight: 10, maxWeight: 1000 }, { minWeight: true, maxWeight: false }).map((reason) => reason.code),
  ["WEIGHT_TOO_LOW"],
  "enabled min weight interception should block below-min packages"
);
assertDeepEqual(
  evaluateWeightInterceptions(300, { ...baseSuggestionChannel, minWeight: -10, maxWeight: -100 }, { minWeight: true, maxWeight: true }),
  [],
  "negative imported weight limits should not make every normal package unavailable"
);
assertDeepEqual(
  evaluateVolumetricWeightInterceptions(900, { ...baseSuggestionChannel, maxWeight: 1000 }, { volumetricDivisor: true }),
  [],
  "near-limit volumetric weight should not make a channel unavailable"
);
assertDeepEqual(
  evaluateVolumetricWeightInterceptions(1200, { ...baseSuggestionChannel, maxWeight: 1000 }, { volumetricDivisor: true }).map((reason) => reason.code),
  ["VOLUMETRIC_WEIGHT_TOO_HIGH"],
  "volumetric weight above max should make a channel unavailable"
);
assertDeepEqual(
  evaluateVolumetricWeightInterceptions(1200, { ...baseSuggestionChannel, maxWeight: 1000 }, { volumetricDivisor: false }),
  [],
  "disabled volumetric interception should not block above-max volumetric weight"
);
assertDeepEqual(
  evaluateDimensionInterceptions(20, 10, 5, { ...baseSuggestionChannel, maxLength: 0, maxWidth: 0, maxHeight: 0, maxSumDimension: 0 }, { maxLength: true, maxSumDimension: true }),
  [],
  "missing dimension limits should not block packages"
);
assertDeepEqual(
  evaluateDimensionInterceptions(70, 50, 40, { ...baseSuggestionChannel, maxLength: 60, maxWidth: 60, maxHeight: 60, maxSumDimension: 999999 }, { maxLength: true, maxSumDimension: true }).map((reason) => reason.code),
  ["EDGE_TOO_LONG"],
  "enabled edge limit should block packages longer than the sortable side limits"
);
assertDeepEqual(
  evaluateDimensionInterceptions(40, 40, 40, { ...baseSuggestionChannel, maxLength: 999999, maxWidth: 999999, maxHeight: 999999, maxSumDimension: 100 }, { maxLength: true, maxSumDimension: true }).map((reason) => reason.code),
  ["SUM_DIMENSION_EXCEEDED"],
  "enabled sum dimension limit should block packages above the sum limit"
);
assertDeepEqual(
  evaluateDimensionInterceptions(-100, 100, 100, { ...baseSuggestionChannel, maxLength: 999999, maxWidth: 999999, maxHeight: 999999, maxSumDimension: 150 }, { maxLength: true, maxSumDimension: true }).map((reason) => reason.code),
  ["SUM_DIMENSION_EXCEEDED"],
  "negative product dimensions should not reduce the sum dimension check"
);
assertDeepEqual(
  detectShippingDimensionLimits(70, 50, 40, { ...baseSuggestionChannel, maxLength: 60, maxWidth: 80, maxHeight: 80, maxSumDimension: 999999 }).map((warning) => warning.type),
  [],
  "dimension warning should compare rotatable package sides instead of raw length field"
);
assertDeepEqual(
  detectShippingDimensionLimits(81, 50, 40, { ...baseSuggestionChannel, maxLength: 60, maxWidth: 80, maxHeight: 80, maxSumDimension: 999999 }).map((warning) => warning.type),
  ["longEdge"],
  "dimension warning should still warn when sorted longest side exceeds the largest allowed side"
);
assertDeepEqual(
  detectShippingDimensionLimits(-100, 100, 100, { ...baseSuggestionChannel, maxLength: 999999, maxWidth: 999999, maxHeight: 999999, maxSumDimension: 150 }).map((warning) => warning.type),
  ["sum"],
  "dimension warning should not let negative dimensions reduce the sum dimension check"
);
assertApproxEqual(
  calculateShippingCost(baseSuggestionChannel, 300, 100, 100, 100, 300),
  11,
  "shipping cost should not apply volumetric fallback when divisor is 0"
);

const malformedDivisorBilling = parseBillingWeight(
  { ...baseSuggestionChannel, billingType: "取大", volumetricDivisor: 17 },
  20,
  15,
  10,
  300
);
assertEqual(malformedDivisorBilling.divisor, 12000, "positive malformed divisor should still fall back to 12000");

const volumetricChannelForComparison = {
  ...baseSuggestionChannel,
  id: "volumetric-comparison",
  billingType: "取大",
  volumetricDivisor: 12000,
};
const actualOnlyCost = calculateShippingCost(baseSuggestionChannel, 300, 50, 50, 50, 300);
const volumetricCost = calculateShippingCost(volumetricChannelForComparison, 300, 50, 50, 50, 300);
assertEqual(
  volumetricCost > actualOnlyCost,
  true,
  "shipping cost comparisons must recalculate billing weight per channel instead of reusing one chargeable weight"
);

const petCarryBagCommission = {
  primaryCategory: "宠物用品",
  secondaryCategory: "宠物便携包",
  tiers: [
    { min: 0, max: 1500, rate: 12 },
    { min: 1500.01, max: 5000, rate: 14 },
    { min: 5000.01, max: Infinity, rate: 15 },
  ],
};
assertEqual(normalizeCommissionPriceRUB(1500.000000001), 1500, "commission price should normalize tiny float noise at 1500");
assertEqual(normalizeCommissionPriceRUB(5000.000000001), 5000, "commission price should normalize tiny float noise at 5000");
assertEqual(getCommissionRate(petCarryBagCommission, 1500), 12, "1500 RUB should use first commission tier");
assertEqual(getCommissionRate(petCarryBagCommission, 1500.000000001), 12, "1500 RUB float noise should still use first commission tier");
assertEqual(getCommissionRate(petCarryBagCommission, 1500.01), 14, "1500.01 RUB should use second commission tier");
assertEqual(getCommissionRate(petCarryBagCommission, 5000), 14, "5000 RUB should use second commission tier");
assertEqual(getCommissionRate(petCarryBagCommission, 5000.000000001), 14, "5000 RUB float noise should still use second commission tier");
assertEqual(getCommissionRate(petCarryBagCommission, 5000.01), 15, "5000.01 RUB should use third commission tier");
assertEqual(
  getCommissionRate({ ...petCarryBagCommission, tiers: [{ min: 0, max: 1500, rate: -5 }] }, 1000),
  0,
  "calculation core should clamp negative commission rates to zero"
);
assertEqual(
  getCommissionRate({ ...petCarryBagCommission, tiers: [{ min: 0, max: 1500, rate: 150 }] }, 1000),
  100,
  "calculation core should cap commission rates at 100%"
);

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
const nonFiniteTargetMarginSuggestion = calculateSuggestedPrice([baseSuggestionChannel], 12, "RMB", baseSuggestionInput, suggestionCommission, NaN);
assertEqual(nonFiniteTargetMarginSuggestion.reason, "profit-target", "non-finite target margin should fall back to default profit target");
assertEqual(nonFiniteTargetMarginSuggestion.targetMargin, 20, "non-finite target margin should normalize to the default target margin");
assertEqual(nonFiniteTargetMarginSuggestion.suggestedPriceRMB > 0, true, "non-finite target margin should not make a fixable channel unfixable");

const preciseSuggestionInput = {
  ...baseSuggestionInput,
  length: 5,
  width: 39,
  height: 3,
  weight: 2600,
  purchaseCost: 35,
  domesticShipping: 0,
  packagingFee: 0,
  returnRate: 0,
  cpaEnabled: true,
  cpaRate: 0,
  cpcEnabled: true,
  cpcBillingMode: "salesPercent",
  cpcSalesPercent: 12,
  targetPriceRMB: 0,
  exchangeRate: 7,
  withdrawalFee: 3,
  paymentFee: 0,
};
const preciseSuggestionChannel = {
  ...baseSuggestionChannel,
  name: "精度测试物流",
  fixFee: 3.2,
  varFeePerGram: 0.03,
  minValue: 100,
  maxValue: 3550,
  minValueRUB: 1200,
  maxValueRUB: 42600,
  billingType: "取大",
  volumetricDivisor: 12000,
};
const preciseSuggestionCommission = {
  primaryCategory: "测试一级",
  secondaryCategory: "测试二级",
  tiers: [
    { min: 0, max: 1500, rate: 8 },
    { min: 1500.01, max: 5000, rate: 13 },
    { min: 5000.01, max: Infinity, rate: 18 },
  ],
};
const preciseSuggestion = calculateSuggestedPrice(
  [preciseSuggestionChannel],
  preciseSuggestionInput.exchangeRate,
  "RMB",
  preciseSuggestionInput,
  preciseSuggestionCommission,
  20
);
const preciseSuggestionResult = performFullCalculation(
  { ...preciseSuggestionInput, targetPriceRMB: preciseSuggestion.suggestedPriceRMB },
  preciseSuggestionCommission,
  preciseSuggestionChannel
);
assertEqual(
  preciseSuggestionResult.profitMargin >= 20,
  true,
  "profit-aware suggested price should not round below target margin"
);

const rubLimitSuggestion = calculateSuggestedPrice(
  [{ ...baseSuggestionChannel, minValueRUB: 240, minValue: 5 }],
  12,
  "RUB"
);
assertEqual(rubLimitSuggestion.suggestedPriceRMB, 20, "RUB value-limit suggestion should use RUB threshold");
const negativeLimitSuggestion = calculateSuggestedPrice(
  [{ ...baseSuggestionChannel, minValue: -50, minValueRUB: -600 }],
  12,
  "RMB"
);
assertEqual(negativeLimitSuggestion.suggestedPriceRMB, 0, "negative value-limit suggestion should not create a positive recommendation");

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

const variableCpcReverseInput = {
  ...baseSuggestionInput,
  length: 33,
  width: 14,
  height: 30,
  weight: 2378,
  purchaseCost: 89,
  domesticShipping: 22,
  packagingFee: 0,
  returnRate: 18,
  cpaEnabled: true,
  cpaRate: 22,
  cpcEnabled: true,
  cpcBillingMode: "salesPercent",
  cpcSalesPercent: 12,
  targetPriceRMB: 428,
  exchangeRate: 11,
  withdrawalFee: 4.8,
  paymentFee: 2,
};
const variableCpcChannel = {
  ...baseSuggestionChannel,
  fixFee: 3.2,
  varFeePerGram: 0.028,
  billingType: "取大",
  volumetricDivisor: 12000,
};
const variableCpcCommission = {
  primaryCategory: "测试一级",
  secondaryCategory: "测试二级",
  tiers: [
    { min: 0, max: 1500, rate: 8 },
    { min: 1500.01, max: 5000, rate: 13 },
    { min: 5000.01, max: Infinity, rate: 18 },
  ],
};
const variableCpcReverse = reversePriceFromMargin(30, variableCpcReverseInput, variableCpcCommission, variableCpcChannel);
const variableCpcForward = performFullCalculation(
  { ...variableCpcReverseInput, targetPriceRMB: variableCpcReverse.priceRMB },
  variableCpcCommission,
  variableCpcChannel
);
assertApproxEqual(variableCpcForward.profitMargin, 30, "reverse price should include variable CPC in target sales margin", 0.05);
const impossibleVariableCpcReverse = reversePriceFromMargin(45, variableCpcReverseInput, variableCpcCommission, variableCpcChannel);
assertEqual(Boolean(impossibleVariableCpcReverse.error), true, "reverse price should reject impossible target margin after variable CPC");

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

const malformedModeCommission = {
  ...petCarryBagCommission,
  modeTiers: {
    RFBS: petCarryBagCommission.tiers,
    FBP: [],
  },
};
assertEqual(getCommissionRate(malformedModeCommission, 1500, "FBP"), 12, "empty FBP mode tiers should fall back to RFBS tiers");
assertEqual(
  getCommissionRate({ ...petCarryBagCommission, modeTiers: { RFBS: [] } }, 1500, "FBP"),
  12,
  "empty RFBS mode tiers should fall back to legacy tiers"
);

const nullMaxCommission = {
  primaryCategory: "测试一级",
  secondaryCategory: "空上限阶梯",
  tiers: [
    { min: 0, max: 1500, rate: 10 },
    { min: 1500.01, max: null, rate: 20 },
  ],
};
assertEqual(getCommissionRate(nullMaxCommission, 6000, "RFBS"), 20, "null max commission tier should mean no upper limit");

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
assertDeepEqual(
  parseShippingRateString("¥-2,6 + ¥-0,035/1g"),
  { fixFee: 0, varFeePerGram: 0 },
  "negative shipping rate should clamp to zero"
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
assertEqual(parseCommissionPercent("-5%"), 0, "negative commission percent should clamp to zero");
assertEqual(parseCommissionPercent("150%"), 100, "commission percent above 100 should cap at 100");

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
const malformedCommissionRows = [
  commissionHeaders,
  ["异常一级", "异常二级", "-5%", "150%", "Infinity"],
];
const malformedCommission = parseCommissionRows(malformedCommissionRows)[0];
assertDeepEqual(
  malformedCommission.tiers.map((tier) => tier.rate),
  [0, 100, 0],
  "malformed commission rates should be clamped before entering tiers"
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
const malformedBatch = parseBatchInput([
  "SKU,一级类目,二级类目,长度,宽度,高度,重量,采购成本,前台售价",
  "BAD1,电子产品,手机配件,-10,-20,Infinity,-300,-5,-100",
].join("\n"));
assertEqual(malformedBatch.rows[0].length, 0, "batch parser should clamp negative length to zero");
assertEqual(malformedBatch.rows[0].width, 0, "batch parser should clamp negative width to zero");
assertEqual(malformedBatch.rows[0].height, 0, "batch parser should clamp infinite height to zero");
assertEqual(malformedBatch.rows[0].weight, 0, "batch parser should clamp negative weight to zero");
assertEqual(malformedBatch.rows[0].purchaseCost, 0, "batch parser should clamp negative purchase cost to zero");
assertEqual(malformedBatch.rows[0].targetPriceRMB, 0, "batch parser should clamp negative target price to zero");
assertEqual(malformedBatch.errors.some((error) => error.includes("目标售价") && error.includes("重量")), true, "malformed batch row should report clamped core fields");
const localizedBatch = parseBatchInput([
  "SKU,一级类目,二级类目,长度,宽度,高度,重量,采购成本,前台售价",
  "NUM1,电子产品,手机配件,30,20,10,\"1,234.56\",\"1 234,56\",\"2.345,67\"",
].join("\n"));
assertApproxEqual(localizedBatch.rows[0].weight || 0, 1234.56, "batch parser should handle comma thousands with dot decimal");
assertApproxEqual(localizedBatch.rows[0].purchaseCost || 0, 1234.56, "batch parser should handle space thousands with comma decimal");
assertApproxEqual(localizedBatch.rows[0].targetPriceRMB || 0, 2345.67, "batch parser should handle dot thousands with comma decimal");

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
    ozonBackendPriceRMB: 313,
    ozonBackendPriceRUB: 3756,
    ozonOriginalPriceRMB: 522,
    ozonOriginalPriceRUB: 6264,
  },
  "Ozon backend pricing"
);
assertEqual(calculateOzonBackendPricing(0, 12).isValid, false, "Ozon pricing invalid without price");
assertEqual(calculateOzonBackendPricing(125, 0).isValid, false, "Ozon pricing invalid without rate");
assertEqual(isProfitMarginBelowThreshold(20, 20), false, "profit threshold should not warn at exact threshold");
assertEqual(isProfitMarginBelowThreshold(19.96, 20), false, "profit threshold should use one-decimal display rounding");
assertEqual(isProfitMarginBelowThreshold(19.94, 20), true, "profit threshold should warn below display threshold");
assertEqual(isProfitMarginBelowThreshold(20.04, 20), false, "profit threshold should not warn above threshold");
assertEqual(normalizePromotionDiscount(-5), 0, "promotion discount should not go below 0%");
assertEqual(normalizePromotionDiscount(100), 99, "promotion discount should be capped below 100%");
assertEqual(Number.isFinite(calculateOriginalPrice(100, 100)), true, "original price should stay finite at invalid 100% discount");
assertApproxEqual(calculateOriginalPrice(100, 25), 133.33333333333334, "original price should reverse valid promotion discount");
assertApproxEqual(calculateOriginalPrice(-100, 25), 0, "negative selling price should not create negative original price");
assertApproxEqual(calculateOriginalPrice(Infinity, 25), 0, "infinite selling price should not create infinite original price");
assertApproxEqual(calculateReturnCost("destroy", -20, 100, 10, 5), 0, "negative return rate should not create negative return cost");
assertApproxEqual(calculateReturnCost("destroy", 200, 100, 10, 5), 115, "return rate above 100% should be capped at one full return loss");
assertApproxEqual(calculateReturnCost("resell", 200, 100, 10, 5), 5, "resell return rate above 100% should cap at one international shipping loss");
assertApproxEqual(calculateReturnCost("productOnly", 200, 100, 10, 5), 100, "product-only return rate above 100% should cap at one product loss");
assertApproxEqual(calculateReturnCost("productOnly", 10, -100, 10, 5), 0, "negative product cost should not create negative return cost");

const adCommission = {
  primaryCategory: "Test",
  secondaryCategory: "Test",
  tertiaryCategory: "Test",
  tiers: [{ min: 0, max: Infinity, rate: 10 }],
};
const baseAdInput = {
  primaryCategory: "Test",
  secondaryCategory: "Test",
  tertiaryCategory: "Test",
  length: 10,
  width: 10,
  height: 10,
  weight: 100,
  purchaseCost: 40,
  domesticShipping: 0,
  packagingFee: 0,
  targetPriceRMB: 100,
  exchangeRate: 10,
  exchangeRateBuffer: 0,
  withdrawalFee: 0,
  paymentFee: 0,
  cpaEnabled: true,
  cpaRate: 22,
  cpcEnabled: false,
  cpcBid: 0,
  cpcConversionRate: 0,
  cpcBillingMode: "bidCvr",
  cpcSalesPercent: 0,
  returnRate: 0,
  returnHandling: "destroy",
  multiItemCount: 1,
  fulfillmentMode: "RFBS",
  valueLimitCurrency: "RUB",
  designatedProviders: [],
  hasBattery: false,
  hasLiquid: false,
  taxEnabled: false,
  vatRate: 0,
  corporateTaxRate: 0,
  promotionDiscount: 0,
  profitWarningThreshold: 20,
};
const safeAdResult = performFullCalculation(baseAdInput, adCommission, undefined);
assertApproxEqual(safeAdResult.adRiskControl.currentACOS, 22, "current ACOS should reflect CPA rate");
assertApproxEqual(safeAdResult.adRiskControl.breakEvenACOS, 50, "break-even ACOS should use pre-ad profit room");
assertEqual(safeAdResult.adRiskControl.isOverBudget, false, "CPA below break-even ACOS should not be over budget");
assertEqual(
  safeAdResult.warnings.some((warning) => warning.includes("ROAS") || warning.includes("广告投放亏损")),
  false,
  "ROAS warning should not contradict safe ACOS"
);
const overBudgetAdResult = performFullCalculation({ ...baseAdInput, cpaRate: 55 }, adCommission, undefined);
assertEqual(overBudgetAdResult.adRiskControl.isOverBudget, true, "CPA above break-even ACOS should be over budget");
assertEqual(
  overBudgetAdResult.warnings.some((warning) => warning.includes("当前 ACOS")),
  true,
  "over-budget ad result should explain ACOS threshold"
);
assertApproxEqual(calculateROAS(-100, 20), 0, "negative revenue should not create negative ROAS");
assertApproxEqual(calculateROAS(100, -20), Infinity, "negative ad cost should not create negative ROAS denominator");
assertApproxEqual(calculateBreakEvenROAS(-100, 20), 0, "negative total cost should not create negative break-even ROAS");
assertApproxEqual(calculateBreakEvenACOS(Infinity, 10, 0, false, 0, 10), 0, "infinite price should not create non-finite break-even ACOS");
assertDeepEqual(
  calculateCVRsensitivity(5, -10, 10, 20, 100),
  { costReduction: 0, profitIncreasePercent: 0, newCost: 0, currentCost: 0 },
  "negative CPC bid should not create negative CVR sensitivity"
);
assertDeepEqual(
  calculateCVRsensitivity(Infinity, 10, 10, 20, 100),
  { costReduction: 0, profitIncreasePercent: 0, newCost: 0, currentCost: 0 },
  "infinite CVR should not create CVR sensitivity"
);
assertApproxEqual(
  calculateMarginalContribution(10, -5, -20, -3),
  0.9,
  "negative percentage fees should not inflate marginal contribution"
);
assertApproxEqual(
  calculateMarginalContribution(10, 200, 0, 0),
  0,
  "withdrawal fee above 100% should be capped at 100% in marginal contribution"
);
assertApproxEqual(
  calculateMarginalContribution(10, 0, 200, 0),
  -0.1,
  "CPA rate above 100% should be capped at 100% in marginal contribution"
);
assertApproxEqual(
  calculateMarginalContribution(10, 0, 0, 200),
  -0.1,
  "payment fee above 100% should be capped at 100% in marginal contribution"
);
assertApproxEqual(
  calculateCpaCost(true, 200, 100),
  100,
  "CPA cost should cap percentage rate at 100%"
);
const excessivePercentageFeeResult = performFullCalculation(
  { ...baseAdInput, cpaEnabled: true, cpaRate: 200, withdrawalFee: 200, paymentFee: 200, cpcEnabled: false },
  adCommission,
  undefined
);
assertApproxEqual(
  excessivePercentageFeeResult.costs.cpaCost,
  100,
  "full calculation CPA cost should cap percentage rate at 100%"
);
assertApproxEqual(
  excessivePercentageFeeResult.costs.withdrawalFee,
  90,
  "full calculation withdrawal fee should cap percentage rate at 100%"
);
assertApproxEqual(
  excessivePercentageFeeResult.costs.paymentFee,
  100,
  "full calculation payment fee should cap percentage rate at 100%"
);
const negativeFeeResult = performFullCalculation(
  { ...baseAdInput, cpaEnabled: true, cpaRate: -20, withdrawalFee: -5, paymentFee: -3, cpcEnabled: false },
  adCommission,
  undefined
);
assertApproxEqual(negativeFeeResult.profitMargin, 50, "negative percentage fees should be treated as zero in full calculation");
assertApproxEqual(negativeFeeResult.costs.cpaCost, 0, "negative CPA rate should not create negative ad cost");
assertApproxEqual(negativeFeeResult.costs.withdrawalFee, 0, "negative withdrawal fee should not create negative cost");
assertApproxEqual(negativeFeeResult.costs.paymentFee, 0, "negative payment fee should not create negative cost");
const negativeCostResult = performFullCalculation(
  { ...baseAdInput, purchaseCost: -40, domesticShipping: -5, packagingFee: -3, returnRate: -50, cpaEnabled: false, cpcEnabled: false },
  adCommission,
  undefined
);
assertApproxEqual(negativeCostResult.costs.purchase, 0, "negative purchase cost should be normalized to zero in full calculation");
assertApproxEqual(negativeCostResult.costs.domesticShipping, 0, "negative domestic shipping should be normalized to zero in full calculation");
assertApproxEqual(negativeCostResult.costs.packaging, 0, "negative packaging fee should be normalized to zero in full calculation");
assertApproxEqual(negativeCostResult.costs.returnCost, 0, "negative return rate should not reduce full calculation cost");
assertApproxEqual(negativeCostResult.profitMargin, 90, "negative fixed costs should not inflate profit beyond zero-cost baseline");
const negativePriceResult = performFullCalculation(
  { ...baseAdInput, targetPriceRMB: -100, cpaEnabled: false, cpcEnabled: false },
  adCommission,
  undefined
);
assertEqual(Number.isFinite(negativePriceResult.netProfit), true, "negative target price should not create non-finite profit");
assertApproxEqual(negativePriceResult.costs.commission, 0, "negative target price should not create negative commission cost");
assertApproxEqual(negativePriceResult.netProfit, -40, "negative target price should be normalized to zero revenue");
assertApproxEqual(negativePriceResult.profitMargin, 0, "negative target price should not create misleading margin");
const infinitePriceResult = performFullCalculation(
  { ...baseAdInput, targetPriceRMB: Infinity, cpaEnabled: false, cpcEnabled: false },
  adCommission,
  undefined
);
assertEqual(Number.isFinite(infinitePriceResult.netProfit), true, "infinite target price should not create infinite profit");
assertApproxEqual(infinitePriceResult.netProfit, -40, "infinite target price should be normalized to zero revenue");
const infiniteTaxSimulation = calculateTaxSimulation(
  { ...baseAdInput, targetPriceRMB: Infinity, purchaseCost: 40, taxEnabled: true, vatRate: 20, corporateTaxRate: 20 },
  10
);
assertEqual(Number.isFinite(infiniteTaxSimulation.outputVat), true, "tax simulation should not emit infinite output VAT");
assertApproxEqual(infiniteTaxSimulation.outputVat, 0, "tax simulation should normalize infinite target price to zero revenue");
const infinitePreTaxSimulation = calculateTaxSimulation(
  { ...baseAdInput, targetPriceRMB: 100, taxEnabled: true, vatRate: 20, corporateTaxRate: 20 },
  Infinity
);
assertDeepEqual(
  [
    Number.isFinite(infinitePreTaxSimulation.preTaxNetProfit),
    Number.isFinite(infinitePreTaxSimulation.corporateTax),
    Number.isFinite(infinitePreTaxSimulation.afterTaxNetProfit),
    Number.isFinite(infinitePreTaxSimulation.afterTaxProfitMargin),
  ],
  [true, true, true, true],
  "tax simulation should normalize non-finite pre-tax profit"
);
assertApproxEqual(infinitePreTaxSimulation.preTaxNetProfit, 0, "non-finite pre-tax profit should normalize to zero");

const exchangeStress = calculateExchangeRateStressTest(100, 10, adCommission, 0, 0, 50, 0, 0, "RFBS");
assertEqual(exchangeStress.at5PercentDrop < 40, true, "5% worse exchange rate should reduce profit");
assertEqual(exchangeStress.at10PercentDrop < exchangeStress.at5PercentDrop, true, "10% worse exchange rate should reduce profit more than 5%");
assertApproxEqual(exchangeStress.zeroProfitRate, 18, "zero-profit exchange rate should be expressed as 1 CNY = N RUB");

const cpcStress = calculateExchangeRateStressTest(200, 10, adCommission, 0, 0, 60, 0, 12, "RFBS");
const expectedCpcStress5 = calculateNetProfit(200 / 1.05, calculateMarginalContribution(10, 0, 0, 0), 60 + (200 / 1.05) * 0.12);
assertApproxEqual(cpcStress.at5PercentDrop, expectedCpcStress5, "exchange stress should include sales-percent CPC at stressed RMB revenue");
const invalidExchangeStress = calculateExchangeRateStressTest(-100, -10, adCommission, -5, -10, -50, -3, -20, "RFBS");
assertEqual(Number.isFinite(invalidExchangeStress.at5PercentDrop), true, "invalid exchange stress should not emit non-finite 5% result");
assertEqual(Number.isFinite(invalidExchangeStress.at10PercentDrop), true, "invalid exchange stress should not emit non-finite 10% result");
assertApproxEqual(invalidExchangeStress.zeroProfitRate, 0, "invalid exchange stress should not emit a fake zero-profit exchange rate");

const invalidProfitCurve = calculateProfitCurve([-100, Infinity, 100], -10, adCommission, -5, -10, -50, -3, -20, "RFBS");
assertDeepEqual(
  invalidProfitCurve.map((point) => ({
    priceRMB: point.priceRMB,
    priceFinite: Number.isFinite(point.priceRMB),
    rubFinite: Number.isFinite(point.priceRUB),
    profitFinite: Number.isFinite(point.profit),
    profitNonNegativeCost: point.profit <= point.priceRMB,
  })),
  [
    { priceRMB: 0, priceFinite: true, rubFinite: true, profitFinite: true, profitNonNegativeCost: true },
    { priceRMB: 0, priceFinite: true, rubFinite: true, profitFinite: true, profitNonNegativeCost: true },
    { priceRMB: 100, priceFinite: true, rubFinite: true, profitFinite: true, profitNonNegativeCost: true },
  ],
  "profit curve should normalize invalid prices and costs"
);
const cappedCpcProfitCurve = calculateProfitCurve([100], 10, adCommission, 0, 0, 50, 0, 200, "RFBS");
assertApproxEqual(
  cappedCpcProfitCurve[0].profit,
  -60,
  "profit curve should cap CPC sales percent at 100%"
);
assertEqual(
  detectCommissionBlackHole(-100, -10, adCommission, -5, -10, -50, Infinity, -3, "RFBS"),
  null,
  "malformed commission black-hole inputs should not create a fake warning"
);
const malformedTierBoundary = detectCommissionTierBoundary(Infinity, -10, adCommission, -5, -10, -50, -3, "RFBS");
assertEqual(Number.isFinite(malformedTierBoundary.lowerPriceRMB || 0), true, "malformed tier boundary should not emit non-finite RMB price");
assertEqual(Number.isFinite(malformedTierBoundary.profitIncrease || 0), true, "malformed tier boundary should not emit non-finite profit increase");
const malformedWeightBoundary = detectShippingWeightBoundary(Infinity, { ...baseSuggestionChannel, pricePerKg: Infinity });
assertEqual(Number.isFinite(malformedWeightBoundary.weightToReduce || 0), true, "malformed weight boundary should not emit non-finite weight reduction");
assertEqual(Number.isFinite(malformedWeightBoundary.costSaving || 0), true, "malformed weight boundary should not emit non-finite cost saving");

const marginStrategyCommission = {
  primaryCategory: "Test",
  secondaryCategory: "Test",
  tiers: [{ min: 0, max: Infinity, rate: 10 }],
};
const marginStrategies = calculatePricingStrategies(marginStrategyCommission, 10, 0, 0, 50, 0, 0, "RFBS");
assertApproxEqual(marginStrategies.breakEven, 55.56, "pricing strategy break-even should target 0% sales margin", 0.01);
assertApproxEqual(marginStrategies.lowProfit, 62.5, "pricing strategy low profit should target 10% sales margin", 0.01);
assertApproxEqual(marginStrategies.mediumProfit, 71.43, "pricing strategy medium profit should target 20% sales margin", 0.01);
assertApproxEqual(marginStrategies.highProfit, 83.34, "pricing strategy high profit should target 30% sales margin", 0.01);
assertApproxEqual(calculateNetProfit(-100, 0.8, -50), 0, "net profit should normalize invalid revenue and fixed cost");
assertApproxEqual(calculateRequiredPriceRMB(-20, 0.8, -50), 0, "required price should normalize invalid target profit and fixed cost");
assertApproxEqual(calculateRequiredPriceRMB(10, 0, 50), 0, "required price should not emit Infinity when marginal contribution is zero");
assertApproxEqual(calculateRequiredPriceRMB(10, -0.1, 50), 0, "required price should not emit Infinity when marginal contribution is negative");
assertApproxEqual(calculateRequiredPriceRMB(10, Infinity, 50), 0, "required price should not emit Infinity when marginal contribution is non-finite");
const malformedStrategies = calculatePricingStrategies(marginStrategyCommission, -10, -5, -10, -50, -3, Infinity, "RFBS");
assertDeepEqual(
  Object.values(malformedStrategies).map((value) => Number.isFinite(value) && value >= 0),
  [true, true, true, true],
  "pricing strategies should stay finite and non-negative for malformed inputs"
);

const zeroFeePricing = calculateSixTierPricing({ ...baseAdInput, cpaEnabled: false, cpaRate: 0 }, adCommission, undefined);
assertEqual(zeroFeePricing[0].disabled, false, "six-tier pricing should calculate with zero withdrawal fee");
assertApproxEqual(zeroFeePricing[0].priceRMB, 42.11, "six-tier pricing should preserve explicit 0% withdrawal fee", 0.01);

const highSalesCpcSixTier = calculateSixTierPricing(
  { ...baseAdInput, cpaEnabled: false, cpaRate: 0, cpcEnabled: true, cpcBillingMode: "salesPercent", cpcSalesPercent: 40 },
  adCommission,
  undefined
);
const highSalesCpcTier = highSalesCpcSixTier.find((tier) => tier.label === "高毛利");
assertEqual(highSalesCpcTier?.disabled, false, "six-tier pricing should solve feasible high sales-percent CPC targets directly");
assertApproxEqual(highSalesCpcTier?.priceRMB || 0, 200, "six-tier high margin price should include sales-percent CPC in denominator", 0.01);
const highSalesCpcForward = performFullCalculation(
  { ...baseAdInput, cpaEnabled: false, cpaRate: 0, cpcEnabled: true, cpcBillingMode: "salesPercent", cpcSalesPercent: 40, targetPriceRMB: highSalesCpcTier?.priceRMB || 0 },
  adCommission,
  undefined
);
assertApproxEqual(highSalesCpcForward.profitMargin, 30, "six-tier high margin price should forward-calculate to target margin", 0.05);

const boundarySalesCpcSixTier = calculateSixTierPricing(
  { ...baseAdInput, purchaseCost: 50, cpaEnabled: false, cpaRate: 0, cpcEnabled: true, cpcBillingMode: "salesPercent", cpcSalesPercent: 30 },
  {
    primaryCategory: "Test",
    secondaryCategory: "TierBoundary",
    tiers: [
      { min: 0, max: 1500, rate: 10 },
      { min: 1500.01, max: 5000, rate: 15 },
      { min: 5000.01, max: null, rate: 20 },
    ],
  },
  undefined
);
const boundaryExtremeTier = boundarySalesCpcSixTier.find((tier) => tier.label === "极限价");
assertEqual(boundaryExtremeTier?.disabled, false, "six-tier pricing should keep feasible commission-boundary targets enabled");
assertApproxEqual(boundaryExtremeTier?.priceRMB || 0, 500, "six-tier pricing should not round a boundary solution into the next commission tier", 0.001);

const multiItemSingle = calculateMultiItemProfit(1, { ...baseSuggestionInput, targetPriceRMB: 100 }, baseSuggestionChannel, suggestionCommission);
const multiItemFull = performFullCalculation({ ...baseSuggestionInput, targetPriceRMB: 100 }, suggestionCommission, baseSuggestionChannel);
assertApproxEqual(multiItemSingle.profitPerItem, multiItemFull.netProfit, "multi-item count 1 should match full calculation net profit");
assertApproxEqual(multiItemSingle.profitMargin, multiItemFull.profitMargin, "multi-item count 1 should match full calculation margin");

const multiItemInput = {
  ...baseSuggestionInput,
  targetPriceRMB: 120,
  cpcEnabled: true,
  cpcBillingMode: "salesPercent",
  cpcSalesPercent: 6,
  returnRate: 10,
};
const multiItemCount = 5;
const multiItemResult = calculateMultiItemProfit(multiItemCount, multiItemInput, baseSuggestionChannel, suggestionCommission);
const multiItemChargeableWeight = getChargeableWeight(
  multiItemInput.length,
  multiItemInput.width,
  multiItemInput.height,
  multiItemInput.weight,
  baseSuggestionChannel
).chargeable;
const multiItemShippingPerItem = calculateShippingCost(baseSuggestionChannel, multiItemChargeableWeight * multiItemCount) / multiItemCount;
const multiItemReturnCost = calculateReturnCost(
  multiItemInput.returnHandling,
  multiItemInput.returnRate,
  multiItemInput.purchaseCost,
  multiItemInput.domesticShipping,
  multiItemShippingPerItem
);
const multiItemCpcCost = calculateCpcCost(
  multiItemInput.cpcEnabled,
  multiItemInput.cpcBid,
  multiItemInput.cpcConversionRate,
  multiItemInput.exchangeRate,
  multiItemInput.cpcBillingMode,
  multiItemInput.cpcSalesPercent,
  multiItemInput.targetPriceRMB
);
const multiItemRate = getCommissionRate(suggestionCommission, multiItemInput.targetPriceRMB * multiItemInput.exchangeRate, multiItemInput.fulfillmentMode);
const multiItemM = calculateMarginalContribution(
  multiItemRate,
  multiItemInput.withdrawalFee,
  multiItemInput.cpaEnabled ? multiItemInput.cpaRate : 0,
  multiItemInput.paymentFee
);
const multiItemFixedCost =
  multiItemInput.purchaseCost +
  multiItemInput.domesticShipping +
  multiItemInput.packagingFee +
  multiItemShippingPerItem +
  multiItemCpcCost +
  multiItemReturnCost;
const expectedMultiItemProfitPerItem = calculateNetProfit(multiItemInput.targetPriceRMB, multiItemM, multiItemFixedCost);
assertApproxEqual(multiItemResult.profitPerItem, expectedMultiItemProfitPerItem, "multi-item profit should use shared shipping per item");
assertApproxEqual(multiItemResult.totalProfit, expectedMultiItemProfitPerItem * multiItemCount, "multi-item total profit should equal per-item profit times count");

const multiItemZeroCount = calculateMultiItemProfit(0, multiItemInput, baseSuggestionChannel, suggestionCommission);
assertEqual(Number.isFinite(multiItemZeroCount.profitPerItem), true, "multi-item count 0 should not produce infinite profit");
assertApproxEqual(
  multiItemZeroCount.profitPerItem,
  calculateMultiItemProfit(1, multiItemInput, baseSuggestionChannel, suggestionCommission).profitPerItem,
  "multi-item count 0 should be normalized to one item"
);
const malformedMultiItem = calculateMultiItemProfit(
  Infinity,
  { ...multiItemInput, targetPriceRMB: Infinity, exchangeRate: -10, withdrawalFee: 200, cpaEnabled: true, cpaRate: 200, paymentFee: 200 },
  { ...baseSuggestionChannel, fixFee: -5, varFeePerGram: -0.02 },
  suggestionCommission
);
assertDeepEqual(
  Object.values(malformedMultiItem).map((value) => Number.isFinite(value)),
  [true, true, true],
  "malformed multi-item profit should not emit non-finite values"
);

const cappedTaxSimulation = calculateTaxSimulation(
  { ...baseSuggestionInput, targetPriceRMB: 100, purchaseCost: 40, domesticShipping: 10, packagingFee: 5, taxEnabled: true, vatRate: 150, corporateTaxRate: 200 },
  30
);
assertApproxEqual(cappedTaxSimulation.outputVat, 100, "VAT rate above 100% should be capped at 100%");
assertApproxEqual(cappedTaxSimulation.inputVatCredit, 55, "input VAT credit should use capped VAT rate");
assertApproxEqual(cappedTaxSimulation.corporateTax, 0, "corporate tax rate above 100% should not create impossible over-tax on non-positive taxable profit");

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
  ["", "Test Standard", "4,8", "2026/5/14", "¥2,6 + ¥0,035/1g", "", "Разрешено", "", "", ""],
])[0];
assertEqual(alternativeShipping.deliveryTimeMin, 5, "alternative shipping date min");
assertEqual(alternativeShipping.deliveryTimeMax, 14, "alternative shipping date max");
assertApproxEqual(alternativeShipping.ozonRating, 4.8, "alternative shipping rating should preserve comma decimal");
assertApproxEqual(normalizeOzonRating("4,8"), 4.8, "shared Ozon rating parser should preserve comma decimal");
assertApproxEqual(normalizeOzonRating("-4,8"), 0, "shared Ozon rating parser should clamp negative rating");
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
const malformedAlternativeShipping = parseAlternativeShippingRows([
  ["Лого", "Метод", "Рейтинг Ozon", "Сроки доставки", "ПВЗ", "Курьер", "Батарейки"],
  ["", "Bad Standard", "-4.8", "bad", "¥-2,6 + ¥-0,035/1g", "", "", "", "", ""],
])[0];
assertDeepEqual(
  {
    fixFee: malformedAlternativeShipping.fixFee,
    varFeePerGram: malformedAlternativeShipping.varFeePerGram,
    pricePerKg: malformedAlternativeShipping.pricePerKg,
    ozonRating: malformedAlternativeShipping.ozonRating,
  },
  { fixFee: 0, varFeePerGram: 0, pricePerKg: 0, ozonRating: 0 },
  "malformed alternative shipping should not emit negative fee or rating"
);

const malformedStructuredShipping = createShippingChannel(
  ["-5", "-0.02", "-60", "-300", "-10", "-4.8"],
  { fixFee: 0, varFeePerGram: 1, maxLength: 2, maxWeight: 3, maxValue: 4, ozonRating: 5 }
);
assertDeepEqual(
  {
    fixFee: malformedStructuredShipping.fixFee,
    varFeePerGram: malformedStructuredShipping.varFeePerGram,
    maxLength: malformedStructuredShipping.maxLength,
    maxWeight: malformedStructuredShipping.maxWeight,
    maxValue: malformedStructuredShipping.maxValue,
    ozonRating: malformedStructuredShipping.ozonRating,
  },
  { fixFee: 0, varFeePerGram: 0, maxLength: 0, maxWeight: 0, maxValue: 0, ozonRating: 0 },
  "structured shipping parser should clamp negative numeric fields"
);

console.log("Parser verification passed.");
