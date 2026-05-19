/**
 * 数据更新脚本
 * 从 CSV 文件读取数据并生成 TypeScript 常量。
 *
 * 重要：业务解析规则复用 lib/*-parsing.ts，不在脚本内维护第二套逻辑。
 */

const fs = require("node:fs");
const path = require("node:path");
const Papa = require("papaparse");
const { loadTsModule } = require("./ts-module-loader");

const {
  parseCommissionRows,
} = loadTsModule(path.join("lib", "commission-parsing.ts"));
const {
  normalizeLimitValue,
  parseDeliveryTime,
  parseShippingRateString,
  parseValueRange,
} = loadTsModule(path.join("lib", "logistics-parsing.ts"));

function parseArgs(argv) {
  const args = {
    checkOnly: false,
    commission: process.env.OZON_COMMISSION_CSV || path.join(__dirname, "../../Tarifs_CN_01_12_2025_1761720496.csv"),
    shipping: process.env.OZON_SHIPPING_CSV || path.join(__dirname, "../../China_scoring_ENG_CN_7_04_26_1775544002.csv"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check-only" || arg === "--dry-run") {
      args.checkOnly = true;
    } else if (arg === "--commission") {
      args.commission = argv[++i];
    } else if (arg === "--shipping") {
      args.shipping = argv[++i];
    }
  }

  return args;
}

function parseCsvRows(csvContent, label) {
  const parsed = Papa.parse(csvContent, {
    header: false,
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) {
    const message = parsed.errors.map((error) => `第 ${error.row ?? "?"} 行：${error.message}`).join("\n");
    throw new Error(`${label} CSV 解析失败：\n${message}`);
  }
  return parsed.data;
}

function parseEuropeanNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "" || value === "-") return fallback;
  const cleaned = String(value).replace(/\s/g, "").replace(",", ".");
  const parsed = Number.parseFloat(cleaned.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDimensionString(dimStr) {
  const result = { maxSum: 999, maxLength: 999 };
  if (!dimStr || String(dimStr).trim() === "") return result;

  const sumMatch = String(dimStr).match(/(?:总和|三边和).*?[≤<=>=]+\s*(\d+)/);
  if (sumMatch) result.maxSum = Number.parseInt(sumMatch[1], 10);

  const lengthMatch = String(dimStr).match(/长边.*?[≤<=>=]+\s*(\d+)/);
  if (lengthMatch) result.maxLength = Number.parseInt(lengthMatch[1], 10);

  return result;
}

function parseVolumetricDivisorFromBillingType(billingType) {
  const normalized = String(billingType || "").toLowerCase();
  if (normalized.includes("实际") && !normalized.includes("最大") && !normalized.includes("取大") && !normalized.includes("max")) {
    return 0;
  }

  const match = normalized.replace(/[\s,]/g, "").match(/[÷/](\d+)/);
  if (match) {
    const divisor = Number.parseInt(match[1], 10);
    if (divisor >= 1000 && divisor <= 20000) return divisor;
  }

  if (normalized.includes("取大") || normalized.includes("最大") || normalized.includes("max") || normalized.includes("体积")) {
    return 12000;
  }

  return 12000;
}

function parseVolumetricDivisor(rawValue, billingType) {
  if (!rawValue || String(rawValue).trim() === "" || String(rawValue).trim() === "-") {
    return parseVolumetricDivisorFromBillingType(billingType);
  }

  const cleaned = String(rawValue).replace(/[\s,]/g, "");
  const parsed = Number.parseInt(cleaned, 10);
  if (parsed >= 1000 && parsed <= 20000) return parsed;

  const match = cleaned.match(/[÷/](\d+)/);
  if (match) {
    const divisor = Number.parseInt(match[1], 10);
    if (divisor >= 1000 && divisor <= 20000) return divisor;
  }

  return parseVolumetricDivisorFromBillingType(billingType);
}

function findShippingHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const joined = rows[i].join(" ").toLowerCase();
    if (
      (joined.includes("配送方式") && joined.includes("第三方物流")) ||
      (joined.includes("尺寸限制") && joined.includes("货值限制")) ||
      joined.includes("shipping")
    ) {
      return i;
    }
  }
  return -1;
}

function uniqueShippingId(name, serviceLevel, counter) {
  const baseId = `${String(name || "").trim().toLowerCase().replace(/\s+/g, "-")}_${String(serviceLevel || "").trim().toLowerCase().replace(/\s+/g, "-")}`;
  const count = counter.get(baseId) || 0;
  counter.set(baseId, count + 1);
  return count > 0 ? `${baseId}_${count + 1}` : baseId;
}

function parseValueLimit(value) {
  const parsed = parseValueRange(value || "");
  return {
    min: parsed.hasLimit && parsed.min > 0 ? normalizeLimitValue(parsed.min) : undefined,
    max: parsed.hasLimit ? normalizeLimitValue(parsed.max) : undefined,
  };
}

function parseShippingCSV(csvContent) {
  const rows = parseCsvRows(csvContent, "物流表");
  const headerIdx = findShippingHeaderRow(rows);
  if (headerIdx === -1) {
    throw new Error("未找到物流表头行（需要包含配送方式/第三方物流/尺寸限制等字段）");
  }

  const channels = [];
  const idCounter = new Map();

  for (const row of rows.slice(headerIdx + 1)) {
    const name = row[3]?.trim();
    if (!name || name === "-") continue;

    const serviceTier = row[0] || "";
    const serviceLevel = row[1] || "";
    const thirdParty = row[2] || "";
    const rating = parseEuropeanNumber(row[4]);
    const time = parseDeliveryTime(row[5] || "");
    const { fixFee, varFeePerGram } = parseShippingRateString(row[6] || "");
    const dimension = parseDimensionString(row[9] || "");
    const minWeight = parseEuropeanNumber(row[10]);
    const maxWeight = parseEuropeanNumber(row[11], 999999);
    const valueRUB = parseValueLimit(row[12]);
    const valueRMB = parseValueLimit(row[13]);
    const billingType = row[16] || "实际重量";
    const volumetricDivisor = parseVolumetricDivisor(row[17], billingType);

    channels.push({
      id: uniqueShippingId(name, serviceLevel, idCounter),
      name,
      thirdParty,
      serviceTier,
      serviceLevel,
      fixFee,
      varFeePerGram,
      pricePerKg: fixFee + varFeePerGram * 1000,
      pricePerCubic: 0,
      minWeight,
      maxWeight,
      maxLength: dimension.maxLength,
      maxWidth: dimension.maxLength,
      maxHeight: dimension.maxLength,
      maxSumDimension: dimension.maxSum,
      deliveryTimeMin: time.min,
      deliveryTimeMax: time.max,
      deliveryTime: Math.round((time.min + time.max) / 2),
      minValueRUB: valueRUB.min,
      maxValueRUB: valueRUB.max,
      minValue: valueRMB.min,
      maxValue: valueRMB.max,
      billingType,
      volumetricDivisor,
      ozonRating: rating,
      batteryAllowed: row[7]?.includes("允许") || row[7]?.toLowerCase().includes("allow") || false,
      liquidAllowed: row[8]?.includes("允许") || row[8]?.toLowerCase().includes("allow") || false,
    });
  }

  return channels;
}

function generateTypeScriptCode(commissions, channels) {
  const jsonReplacer = (_key, value) => {
    if (value === Infinity) return "Infinity";
    return value;
  };

  const commissionStr = JSON.stringify(commissions, jsonReplacer, 2).replace(/"Infinity"/g, "Infinity");
  const channelStr = JSON.stringify(channels, jsonReplacer, 2).replace(/"Infinity"/g, "Infinity");

  return `// ========================================================
// 自动生成的数据文件 (更新时间: ${new Date().toLocaleString("zh-CN")})
// 数据来源:
//   - 佣金数据: CSV
//   - 物流数据: CSV
// ========================================================

import { CategoryCommission, ShippingChannel } from './types';

export const DEFAULT_COMMISSION_DATA: CategoryCommission[] = ${commissionStr};

export const DEFAULT_SHIPPING_DATA: ShippingChannel[] = ${channelStr};
`;
}

function printSummary(commissions, channels) {
  const channelsWithRmbValue = channels.filter((channel) => channel.minValue !== undefined || channel.maxValue !== undefined).length;
  const channelsWithRubValue = channels.filter((channel) => channel.minValueRUB !== undefined || channel.maxValueRUB !== undefined).length;
  const dateLikeDelivery = channels.filter((channel) => channel.deliveryTimeMin > 0 && channel.deliveryTimeMax > channel.deliveryTimeMin).length;
  console.log(`✓ 成功解析佣金数据: ${commissions.length} 条`);
  console.log(`✓ 成功解析物流数据: ${channels.length} 条`);
  console.log(`  - 人民币货值: ${channelsWithRmbValue} 条`);
  console.log(`  - 卢布货值: ${channelsWithRubValue} 条`);
  console.log(`  - 时效区间: ${dateLikeDelivery} 条`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log("开始更新数据...\n");
    console.log("读取佣金数据:", args.commission);
    console.log("读取物流数据:", args.shipping);

    const commissionCSV = fs.readFileSync(args.commission, "utf8");
    const shippingCSV = fs.readFileSync(args.shipping, "utf8");
    const commissions = parseCommissionRows(parseCsvRows(commissionCSV, "佣金表"));
    const channels = parseShippingCSV(shippingCSV);
    printSummary(commissions, channels);

    if (args.checkOnly) {
      console.log("\n✅ 校验完成，未写入文件。");
      return;
    }

    const outputPath = path.join(__dirname, "../lib/default-data.ts");
    fs.writeFileSync(outputPath, generateTypeScriptCode(commissions, channels), "utf8");
    console.log(`\n✅ 已生成: ${outputPath}`);
  } catch (error) {
    console.error("❌ 更新失败:", error);
    process.exit(1);
  }
}

main();
