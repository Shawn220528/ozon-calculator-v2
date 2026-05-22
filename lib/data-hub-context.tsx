"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { CategoryCommission, ImportSummary, ShippingChannel, UnavailableShippingChannel, ShippingInterceptionReason } from "./types";
import {
  COMMISSION_COLUMN_KEYWORDS,
  SHIPPING_COLUMN_KEYWORDS,
  mapColumnsByKeywords,
  checkRequiredFields,
} from "./column-keywords";
import { DEFAULT_COMMISSION_DATA, DEFAULT_SHIPPING_DATA } from "./default-data";
import { buildColumnMapping, getFieldSchema, LOGISTICS_FIELDS } from "./constants";
import { cnyToRub } from "./currency";
import type { ValueLimitCurrency } from "./currency";
import {
  normalizeLimitValue,
  parseDeliveryTime as parseDeliveryTimeShared,
  parseShippingRateString as parseShippingRateStringShared,
  parseValueRange as parseValueRangeShared,
} from "./logistics-parsing";
import {
  normalizeCommissionCategory,
  parseCommissionWorkbookRows,
  selectCommissionSheetName,
} from "./commission-parsing";
import { parseAlternativeShippingRows } from "./shipping-alternative-parsing";
import { isSkippableShippingRow, selectShippingSheetName } from "./shipping-workbook";
import { parseEuropeanNumber } from "./number-parsing";

// 佣金阶梯金额边界
const TIER_BOUNDARIES = [
  { min: 0, max: 1500 },
  { min: 1500.01, max: 5000 },
  { min: 5000.01, max: Infinity },
] as const;

function countCommissionTiers(data: CategoryCommission[], mode: "RFBS" | "FBP"): number {
  return data.reduce((sum, item) => sum + (item.modeTiers?.[mode] || item.tiers).length, 0);
}

// 列映射配置类型
export interface ColumnMapping {
  commission: Record<string, number>; // 佣金表列映射
  shipping: Record<string, number>;   // 物流表列映射
}

interface DataHubContextType {
  commissionData: CategoryCommission[];
  shippingData: ShippingChannel[];
  commissionLoaded: boolean;
  shippingLoaded: boolean;
  columnMapping: ColumnMapping;
  interceptionConfig: Record<string, boolean>; // 🔹 拦截配置
  lastImportSummary: ImportSummary | null;
  loadCommissionData: (file: File, mode?: "overwrite" | "merge", mappingOverride?: Record<string, number>) => Promise<ImportSummary>;
  loadShippingData: (file: File, mode?: "overwrite" | "merge", mappingOverride?: Record<string, number>) => Promise<ImportSummary>;
  clearCommissionData: () => void;
  clearShippingData: () => void;
  updateColumnMapping: (type: "commission" | "shipping", mapping: Record<string, number>) => void;
  updateInterceptionConfig: (config: Record<string, boolean>) => void;
  getCategories: () => { primary: string; secondary: { name: string; tertiary: string[] }[] }[];
  getCommissionByCategory: (primary: string, secondary: string, tertiary?: string) => CategoryCommission | undefined;
  getShippingChannels: (
    length: number,
    width: number,
    height: number,
    weight: number,
    priceRMB: number,
    rubPerCny: number,
    valueLimitCurrency?: ValueLimitCurrency,
    hasBattery?: boolean,
    hasLiquid?: boolean,
    designatedProvider?: string
  ) => { available: ShippingChannel[]; unavailable: UnavailableShippingChannel[] };
}

const DataHubContext = createContext<DataHubContextType | undefined>(undefined);

// ========================================================
// 工具函数
// ========================================================
/**
 * 安全写入 localStorage（含容量保护）
 * 当数据过大或写入失败时，自动降级处理
 */
function safeLocalStorageSet(key: string, value: string): { success: boolean; error?: string } {
  try {
    // 预检：估算数据大小（5MB 为安全上限）
    const sizeKB = new Blob([value]).size / 1024;
    if (sizeKB > 4500) {
      console.warn(`[localStorage保护] 数据过大 (${sizeKB.toFixed(0)}KB)，跳过持久化: ${key}`);
      return { success: false, error: `数据过大 (${sizeKB.toFixed(0)}KB)` };
    }
    localStorage.setItem(key, value);
    return { success: true };
  } catch (e) {
    // QuotaExceededError
    console.warn(`[localStorage保护] 写入失败: ${key}`, e);
    // 尝试清除旧数据重试
    try {
      localStorage.removeItem(key);
      localStorage.setItem(key, value);
      return { success: true };
    } catch {
      return { success: false, error: '存储空间不足' };
    }
  }
}

/**
 * 智能寻找真实表头行（物流表 XLSX）
 * 查找包含 "配送方式"、"第三方物流" 或 "尺寸限制" 的行
 */
function findShippingHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    const joined = row.join(" ").toLowerCase();
    if (joined.includes("配送方式") && (joined.includes("尺寸限制") || joined.includes("重量限制"))) {
      return i;
    }
    if (joined.includes("scoring group") && joined.includes("delivery method") && joined.includes("shipment weight limits")) {
      return i;
    }
    if (joined.includes("deliveryvariant") && joined.includes("weight")) {
      return i;
    }
    // 俄文备选
    if (joined.includes("метод") && joined.includes("размер")) {
      return i;
    }
  }
  return -1;
}

/**
 * 增强版费率字符串解析函数
 * 支持多种格式、货币符号、特殊字符过滤
 * 
 * 格式示例:
 *   - "¥3.12 + ¥0.0468/1 g"
 *   - "$0.38 + $0.00522/1 g"
 *   - "¥2,75 + ¥0,0385/1 г"
 *   - "3.12 RMB + 0.0468 RMB/g"
 *   - "固定费: 3.12元，变动费: 0.0468元/克"
 * 
 * 返回 { fixFee: RMB, varFeePerGram: RMB/g }
 */
function parseShippingRateString(rateStr: string): { fixFee: number; varFeePerGram: number } {
  return parseShippingRateStringShared(rateStr);
}

/**
 * 解析尺寸限制字符串
 * 格式示例: "边长总和 ≤ 90 cm, 长边 ≤ 60 cm", "总和少于90", "长边<60"
 * 返回 { maxSum, maxLength }
 */
function parseDimensionString(dimStr: string): { maxSum: number; maxLength: number } {
  const result = { maxSum: Infinity, maxLength: Infinity };

  if (!dimStr || dimStr.trim() === "") return result;

  // 🔹 中文：边长总和限制（兼容 ≤, <=, <, 少于, 不超过）
  const sumPatterns = [
    /边长总和\s*[≤<]\s*(\d+)/,
    /边长总和\s*(?:少于|不超过)\s*(\d+)/,
    /尺寸总和\s*[≤<]\s*(\d+)/,
    /尺寸总和\s*(?:少于|不超过)\s*(\d+)/,
    /三边总和\s*[≤<]\s*(\d+)/,
    /三边总和\s*(?:少于|不超过)\s*(\d+)/,
    /总尺寸\s*[≤<]\s*(\d+)/,
    /总尺寸\s*(?:少于|不超过)\s*(\d+)/,
    /总和\s*[≤<]\s*(\d+)/,
    /总和\s*(?:少于|不超过)\s*(\d+)/,
    /sum\s*[≤<]\s*(\d+)/i,
    /сумма\s*[≤<]\s*(\d+)/i,
  ];
  
  for (const pattern of sumPatterns) {
    const match = dimStr.match(pattern);
    if (match) {
      result.maxSum = parseInt(match[1]);
      break;
    }
  }

  // 🔹 中文：长边限制（兼容 ≤, <=, <, 少于, 不超过）
  const lengthPatterns = [
    /长边\s*[≤<]\s*(\d+)/,
    /长边\s*(?:少于|不超过)\s*(\d+)/,
    /最长边\s*[≤<]\s*(\d+)/,
    /最长边\s*(?:少于|不超过)\s*(\d+)/,
    /最大边\s*[≤<]\s*(\d+)/,
    /最大边\s*(?:少于|不超过)\s*(\d+)/,
    /长度\s*[≤<]\s*(\d+)/,
    /长度\s*(?:少于|不超过)\s*(\d+)/,
    /(?:max\s*)?length\s*[≤<]\s*(\d+)/i,
    /длин[аы]?\s*[≤<]\s*(\d+)/i,
  ];
  
  for (const pattern of lengthPatterns) {
    const match = dimStr.match(pattern);
    if (match) {
      result.maxLength = parseInt(match[1]);
      break;
    }
  }

  // 🔹 打印解析结果
  // (dimension parsing result used internally)

  return result;
}

/**
 * 解析货值限制字符串
 * 格式示例: "1 - 1500", "0.01 - 135", "1 501 - 7,000" (带千分位空格)
 * 返回 { min, max }
 */
function parseValueRange(valStr: string): { min: number; max: number; hasLimit: boolean } {
  return parseValueRangeShared(valStr);
}

/**
 * 从行数据解析体积重除数
 * 支持多种格式：纯数字、"÷12000"、"/12000"、带空格的 "12 000" 等
 */
function parseVolumetricDivisorFromRow(rawValue: string, billingType: string): number {
  if (!rawValue || rawValue.trim() === "" || rawValue.trim() === "-") {
    return parseVolumetricDivisorFromBillingType(billingType);
  }
  
  // 移除千分位空格和逗号
  const cleaned = String(rawValue).replace(/[\s,]/g, "");
  const parsed = parseInt(cleaned);
  
  if (parsed >= 1000 && parsed <= 20000) return parsed;
  
  // 尝试从字符串中提取除数模式
  const match = cleaned.match(/[÷/](\d+)/);
  if (match) {
    const d = parseInt(match[1]);
    if (d >= 1000 && d <= 20000) return d;
  }
  
  // 回退到 billingType 解析
  return parseVolumetricDivisorFromBillingType(billingType);
}

/**
 * 从计费类型字符串解析体积重除数
 * 纯实际重量 → 0（不计抛），取大/体积 → 默认 12000
 */
function parseVolumetricDivisorFromBillingType(billingType: string): number {
  const normalized = (billingType || "").toLowerCase();
  
  // 纯实际重量 / physical weight：不计抛
  if (
    (normalized.includes("实际") || normalized.includes("physical")) &&
    !normalized.includes("最大") &&
    !normalized.includes("取大") &&
    !normalized.includes("max") &&
    !normalized.includes("volume")
  ) {
    return 0;
  }
  
  // 从 billingType 中提取除数
  const patterns = [/÷(\d+)/, /\/(\d+)/];
  for (const pattern of patterns) {
    const match = normalized.replace(/[\s,]/g, "").match(pattern);
    if (match) {
      const d = parseInt(match[1]);
      if (d >= 1000 && d <= 20000) return d;
    }
  }
  
  // 取大/体积/默认 → 12000
  if (normalized.includes("取大") || normalized.includes("最大") || normalized.includes("max") || normalized.includes("体积") || normalized.includes("volume")) {
    return 12000;
  }
  
  // 默认 12000（Ozon 标准系数）
  return 12000;
}

/**
 * 生成物流渠道唯一标识符
 * 格式: [配送方式名称]_[服务等级]
 * 用于数据覆盖和去重
 */
function generateShippingUniqueId(name: string, serviceLevel: string): string {
  const normalizedName = (name || "").trim().toLowerCase().replace(/\s+/g, "-");
  const normalizedLevel = (serviceLevel || "").trim().toLowerCase().replace(/\s+/g, "-");
  return `${normalizedName}_${normalizedLevel}`;
}

/**
 * 解析时效限制字符串
 * 格式示例: "5-14"、"5月14日"、"2026/5/14"、"5/14/2026"
 * 返回 { min, max }
 */
function parseDeliveryTime(timeStr: string): { min: number; max: number } {
  const parsed = parseDeliveryTimeShared(timeStr);
  return { min: parsed.min, max: parsed.max };
}





// ========================================================
// Provider
// ========================================================
export function DataHubProvider({ children }: { children: React.ReactNode }) {
  const [commissionData, setCommissionData] = useState<CategoryCommission[]>(DEFAULT_COMMISSION_DATA);
  const [shippingData, setShippingData] = useState<ShippingChannel[]>(DEFAULT_SHIPPING_DATA);
  const [commissionLoaded, setCommissionLoaded] = useState(true);
  const [shippingLoaded, setShippingLoaded] = useState(true);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    commission: {},
    shipping: {},
  });
  const [lastImportSummary, setLastImportSummary] = useState<ImportSummary | null>(null);
  
  // 🔹 拦截配置状态（从 localStorage 恢复）
  const [interceptionConfig, setInterceptionConfig] = useState<Record<string, boolean>>({});

  // 从 localStorage 恢复拦截配置
  useEffect(() => {
    try {
      const savedConfig = localStorage.getItem("ozon_interception_config");
      if (savedConfig) {
        const parsed = JSON.parse(savedConfig);
        setInterceptionConfig(parsed);
      }
    } catch (e) {
      console.error("[数据中心] 恢复拦截配置失败:", e);
    }
  }, []);
  useEffect(() => {
    try {
      // 🔹 数据版本控制：兼容迁移而非暴力清除
      const DATA_VERSION = "v2.4"; // 兼容升级，共享物流解析器与人民币/卢布货值摘要
      const savedVersion = localStorage.getItem("ozon_data_version");
      
      // 🔹 先读取所有数据，避免作用域问题
      const savedCommission = localStorage.getItem("ozon_commission_data");
      const savedShipping = localStorage.getItem("ozon_shipping_data");
      const savedMapping = localStorage.getItem("ozon_column_mapping");
      
      const isMajorUpgrade = Boolean(savedVersion && !savedVersion.startsWith("v2"));

      if (savedVersion !== DATA_VERSION) {
        // 🔴 修复：版本升级时不再暴力清除，而是保留用户数据
        // 仅在数据格式完全不兼容时才清除（如 v1.x → v2.x）
        if (isMajorUpgrade) {
          localStorage.removeItem("ozon_commission_data");
          localStorage.removeItem("ozon_shipping_data");
          localStorage.removeItem("ozon_column_mapping");
        }
        // 更新版本号
        safeLocalStorageSet("ozon_data_version", DATA_VERSION);
      }

      if (!isMajorUpgrade) {
        if (savedCommission) {
          const parsed = JSON.parse(savedCommission);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setCommissionData(parsed);
            setCommissionLoaded(true);
          }
        }
        
        if (savedShipping) {
          const parsed = JSON.parse(savedShipping);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // 🔴 强制修复：如果 volumetricDivisor < 1000，重写为 12000
            const fixedParsed = parsed.map((item: ShippingChannel) => {
              if (item.volumetricDivisor !== undefined && item.volumetricDivisor < 1000) {
                return { ...item, volumetricDivisor: 12000 };
              }
              return item;
            });
            
            // 检查并修复重复ID
            const idSet = new Set<string>();
            const hasDuplicates = fixedParsed.some((item: ShippingChannel) => {
              if (idSet.has(item.id)) return true;
              idSet.add(item.id);
              return false;
            });
            
            if (hasDuplicates) {
              localStorage.removeItem("ozon_shipping_data");
              setShippingData(DEFAULT_SHIPPING_DATA);
            } else {
              setShippingData(fixedParsed);
              // 如果有修复，更新 localStorage
              const hasFixed = fixedParsed.some((item: ShippingChannel, i: number) => 
                item.volumetricDivisor !== parsed[i].volumetricDivisor
              );
              if (hasFixed) {
                safeLocalStorageSet("ozon_shipping_data", JSON.stringify(fixedParsed));
              }
            }
          }
        }
        
        if (savedMapping) {
          const parsed = JSON.parse(savedMapping);
          if (parsed.commission && parsed.shipping) {
            setColumnMapping(parsed);
          }
        }
      }
    } catch (e) {
      console.error("[数据中心] localStorage 恢复失败:", e);
    }
  }, []);

  /**
   * 加载佣金数据（CSV 或 XLSX）
   * 核心改进：智能寻找真实表头行
   */
  const loadCommissionData = useCallback(async (file: File, _mode: "overwrite" | "merge" = "overwrite", mappingOverride?: Record<string, number>) => {
    return new Promise<ImportSummary>((resolve, reject) => {
      const ext = file.name.split(".").pop()?.toLowerCase();

      const parseRows = (rawRows: string[][], sheetName?: string) => {
        return parseCommissionWorkbookRows(rawRows, sheetName, mappingOverride);
      };

      if (ext === "csv") {
        Papa.parse(file, {
          header: false,   // 不自动使用第一行作为 header
          skipEmptyLines: true,
          complete: (results) => {
            try {
              const rawRows = results.data as string[][];
              const parsed = parseRows(rawRows);
              setCommissionData(parsed);
              setCommissionLoaded(true);
              safeLocalStorageSet("ozon_commission_data", JSON.stringify(parsed));
              const summary: ImportSummary = {
                type: "commission",
                rows: rawRows.length,
                categories: parsed.length,
                commissionTierMapped: countCommissionTiers(parsed, "RFBS") + countCommissionTiers(parsed, "FBP"),
                commissionModeMapped: {
                  RFBS: countCommissionTiers(parsed, "RFBS"),
                  FBP: countCommissionTiers(parsed, "FBP"),
                },
              };
              setLastImportSummary(summary);
              resolve(summary);
            } catch (e) {
              reject(e);
            }
          },
          error: (error) => reject(error),
        });
      } else if (ext === "xlsx" || ext === "xls") {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = new Uint8Array(e.target?.result as ArrayBuffer);
            const workbook = XLSX.read(data, { type: "array" });
            const firstSheetName = selectCommissionSheetName(workbook.SheetNames);
            if (!firstSheetName) {
              throw new Error("未找到可解析的佣金工作表");
            }
            const worksheet = workbook.Sheets[firstSheetName];
            const rawRows = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1, defval: "", raw: false });
            const parsed = parseRows(rawRows, firstSheetName);
            setCommissionData(parsed);
            setCommissionLoaded(true);
            safeLocalStorageSet("ozon_commission_data", JSON.stringify(parsed));
            const summary: ImportSummary = {
              type: "commission",
              rows: rawRows.length,
              categories: parsed.length,
              commissionSheetName: firstSheetName,
              commissionTierMapped: countCommissionTiers(parsed, "RFBS") + countCommissionTiers(parsed, "FBP"),
              commissionModeMapped: {
                RFBS: countCommissionTiers(parsed, "RFBS"),
                FBP: countCommissionTiers(parsed, "FBP"),
              },
            };
            setLastImportSummary(summary);
            resolve(summary);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsArrayBuffer(file);
      } else {
        reject(new Error("不支持的文件格式，请上传 .csv 或 .xlsx 文件"));
      }
    });
  }, []);

  /**
   * 加载物流数据（XLSX 或 CSV）
   * 核心改进：智能寻找真实表头行，解析 Ozon 真实费率格式
   * 
   * @param file 上传的文件
   * @param mode 加载模式：overwrite（覆盖，默认）或 merge（并存更新）
   */
  const loadShippingData = useCallback(async (file: File, mode: "overwrite" | "merge" = "overwrite", mappingOverride?: Record<string, number>) => {
    return new Promise<ImportSummary>((resolve, reject) => {
      const ext = file.name.split(".").pop()?.toLowerCase();

      const makeShippingSummary = (rawRows: string[][], finalData: ShippingChannel[]): ImportSummary => ({
        type: "shipping",
        rows: rawRows.length,
        channels: finalData.length,
        valueRMBMapped: finalData.filter((ch) => ch.minValue !== undefined || ch.maxValue !== undefined).length,
        valueRUBMapped: finalData.filter((ch) => ch.minValueRUB !== undefined || ch.maxValueRUB !== undefined).length,
        deliveryTimeMapped: finalData.filter((ch) => ch.deliveryTimeMin > 0 || ch.deliveryTimeMax > 0).length,
        volumetricMapped: finalData.filter((ch) => ch.volumetricDivisor && ch.volumetricDivisor > 0).length,
      });

      const parseShippingRows = (rawRows: string[][], sheetName?: string): ShippingChannel[] => {
        // 智能寻找真实表头行
        const headerIdx = findShippingHeaderRow(rawRows);

        if (headerIdx === -1) {
          // 如果找不到标准表头，尝试用第一个有内容的行
          // 尝试使用 Список без неинтегр. 3PL sheet 的格式
          return parseAlternativeShippingFormat(rawRows);
        }

        const headers = rawRows[headerIdx];
        const dataRows = rawRows.slice(headerIdx + 1);

        // 🔴 重构：使用 Schema Registry 进行列映射（零硬编码）
        const colMap = mappingOverride ?? buildColumnMapping(headers);
        
        // 兼容性映射：将 registry key 映射到原有变量名
        const fieldMapping = {
          name: colMap['name'] ?? -1,
          serviceLevel: colMap['serviceLevel'] ?? -1,
          tier: colMap['serviceTier'] ?? -1,
          thirdParty: colMap['thirdParty'] ?? -1,
          rating: colMap['rating'] ?? -1,
          deliveryTime: colMap['deliveryTime'] ?? -1,
          rate: colMap['rate'] ?? -1,
          battery: colMap['battery'] ?? -1,
          liquid: colMap['liquid'] ?? -1,
          dimension: colMap['dimension'] ?? -1,
          minWeight: colMap['minWeight'] ?? -1,
          maxWeight: colMap['maxWeight'] ?? -1,
          valueRUB: colMap['valueRUB'] ?? -1,
          valueRMB: colMap['valueRMB'] ?? -1,
          billingType: colMap['billingType'] ?? -1,
          volumetricDivisor: colMap['volumetricDivisor'] ?? -1,
        };

        const parsed: ShippingChannel[] = [];
        const idCounter = new Map<string, number>(); // 跟踪ID出现次数
        let idx = 0;

        for (const row of dataRows) {
          try {
            const name = fieldMapping.name >= 0 ? row[fieldMapping.name]?.trim() : "";
            if (isSkippableShippingRow(row, name)) continue;

            const serviceLevel = fieldMapping.serviceLevel >= 0 ? row[fieldMapping.serviceLevel]?.trim() || "" : "";
            let uniqueId = generateShippingUniqueId(name, serviceLevel);
            
            // 处理重复ID：添加序号后缀
            const count = idCounter.get(uniqueId) || 0;
            if (count > 0) {
              uniqueId = `${uniqueId}_${count + 1}`;
            }
            idCounter.set(generateShippingUniqueId(name, serviceLevel), count + 1);

            const rateStr = fieldMapping.rate >= 0 ? row[fieldMapping.rate] || "" : "";
            const { fixFee, varFeePerGram } = parseShippingRateString(rateStr);

            const dimStr = fieldMapping.dimension >= 0 ? row[fieldMapping.dimension] || "" : "";
            const { maxSum, maxLength: maxLen } = parseDimensionString(dimStr);

            const timeStr = fieldMapping.deliveryTime >= 0 ? row[fieldMapping.deliveryTime] || "" : "";
            const { min: dmin, max: dmax } = parseDeliveryTime(timeStr);

            const valRUBStr = fieldMapping.valueRUB >= 0 ? row[fieldMapping.valueRUB] || "" : "";
            const valRMBStr = fieldMapping.valueRMB >= 0 ? row[fieldMapping.valueRMB] || "" : "";
            const valRUB = parseValueRange(valRUBStr);
            const valRMB = parseValueRange(valRMBStr);

            // 🔴 修复：使用 parseEuropeanNumber 替代 parseFloat，正确处理 "30,000" 和 "30 000" 等格式
            const minW = fieldMapping.minWeight >= 0 ? parseEuropeanNumber(row[fieldMapping.minWeight]) || 0 : 0;
            const maxW = fieldMapping.maxWeight >= 0 ? parseEuropeanNumber(row[fieldMapping.maxWeight]) || 999999 : 999999;

            const batteryAllowed = fieldMapping.battery >= 0 ? row[fieldMapping.battery]?.includes("允许") || row[fieldMapping.battery]?.toLowerCase().includes("allow") || row[fieldMapping.battery]?.includes("Разрешено") : false;
            const liquidAllowed = fieldMapping.liquid >= 0 ? row[fieldMapping.liquid]?.includes("允许") || row[fieldMapping.liquid]?.toLowerCase().includes("allow") || row[fieldMapping.liquid]?.includes("Разрешено") : false;

            const billingType = fieldMapping.billingType >= 0 ? row[fieldMapping.billingType]?.trim() || "实际重量" : "实际重量";

            // 🔴 修复：从 billingType 或 volumetricDivisor 列解析实际除数，而非硬编码 12000
            // Budget 等不计抛渠道除数为 0，若硬编码会导致误计抛
            const rawVolDivisor = fieldMapping.volumetricDivisor >= 0 ? row[fieldMapping.volumetricDivisor] || "" : "";
            const volDivisor = rawVolDivisor ? parseVolumetricDivisorFromRow(rawVolDivisor, billingType) : parseVolumetricDivisorFromBillingType(billingType);

            idx++;
            parsed.push({
              id: uniqueId, // 使用唯一标识符
              name,
              thirdParty: fieldMapping.thirdParty >= 0 ? row[fieldMapping.thirdParty]?.trim() || "" : "",
              serviceTier: fieldMapping.tier >= 0 ? row[fieldMapping.tier]?.trim() || "" : "",
              serviceLevel,
              fixFee,
              varFeePerGram,
              pricePerKg: fixFee + varFeePerGram * 1000,
              pricePerCubic: 0,
              minWeight: minW,
              maxWeight: maxW,
              maxLength: maxLen,
              maxWidth: maxLen,  // 默认和 maxLength 相同
              maxHeight: maxLen,
              maxSumDimension: maxSum,
              deliveryTimeMin: dmin,
              deliveryTimeMax: dmax,
              deliveryTime: Math.round((dmin + dmax) / 2),
              minValueRUB: valRUB.hasLimit && valRUB.min > 0 ? valRUB.min : undefined,
              maxValueRUB: valRUB.hasLimit ? valRUB.max : undefined,
              minValue: valRMB.hasLimit && valRMB.min > 0 ? valRMB.min : undefined,
              maxValue: valRMB.hasLimit ? valRMB.max : undefined,
              billingType,
              volumetricDivisor: volDivisor,  // 🔴 关键修复：从CSV解析除数
              ozonRating: fieldMapping.rating >= 0 ? parseFloat(row[fieldMapping.rating]) || 0 : 0,
              batteryAllowed,
              liquidAllowed,
            });
          } catch (error) {
            console.warn(`[物流解析警告] 第 ${idx + 1} 行解析失败:`, row, error);
          }
        }

        return parsed;
      };

      /**
       * 备选解析格式：Список без неинтегр. 3PL sheet
       * Header: Лого, Метод, Рейтинг Ozon, Сроки доставки, ПВЗ, Курьер, Батарейки, ..., Fix, Var, Валюта, Мин. Срок, Макс. срок
       */
      const parseAlternativeShippingFormat = (rawRows: string[][]): ShippingChannel[] => {
        return parseAlternativeShippingRows(rawRows);
      };

      if (ext === "xlsx" || ext === "xls") {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = new Uint8Array(e.target?.result as ArrayBuffer);
            const workbook = XLSX.read(data, { type: "array" });

            const sheetName = selectShippingSheetName(workbook.SheetNames);
            if (!sheetName) {
              throw new Error("未找到可解析的物流工作表");
            }

            const worksheet = workbook.Sheets[sheetName];
            const rawRows = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1, defval: "", raw: false });

            const parsed = parseShippingRows(rawRows, sheetName);

            // 根据 mode 处理数据
            let finalData: ShippingChannel[];
            if (mode === "overwrite") {
              finalData = parsed;
            } else {
              // merge 模式：根据 uniqueId 合并
              const existingMap = new Map(shippingData.map(ch => [ch.id, ch]));
              parsed.forEach(ch => {
                existingMap.set(ch.id, ch); // 覆盖或新增
              });
              finalData = Array.from(existingMap.values());
            }

            setShippingData(finalData);
            setShippingLoaded(true);
            safeLocalStorageSet("ozon_shipping_data", JSON.stringify(finalData));
            const summary = makeShippingSummary(rawRows, finalData);
            setLastImportSummary(summary);
            resolve(summary);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsArrayBuffer(file);
      } else if (ext === "csv") {
        Papa.parse(file, {
          header: false,
          skipEmptyLines: true,
          complete: (results) => {
            try {
              const rawRows = results.data as string[][];
              const parsed = parseShippingRows(rawRows);

              // 根据 mode 处理数据
              let finalData: ShippingChannel[];
              if (mode === "overwrite") {
                finalData = parsed;
              } else {
                // merge 模式：根据 uniqueId 合并
                const existingMap = new Map(shippingData.map(ch => [ch.id, ch]));
                parsed.forEach(ch => {
                  existingMap.set(ch.id, ch); // 覆盖或新增
                });
                finalData = Array.from(existingMap.values());
              }

              setShippingData(finalData);
              setShippingLoaded(true);
              safeLocalStorageSet("ozon_shipping_data", JSON.stringify(finalData));
              const summary = makeShippingSummary(rawRows, finalData);
              setLastImportSummary(summary);
              resolve(summary);
            } catch (e) {
              reject(e);
            }
          },
          error: (error) => reject(error),
        });
      } else {
        reject(new Error("不支持的文件格式，请上传 .csv 或 .xlsx 文件"));
      }
    });
  }, [shippingData]);

  /**
   * 清除佣金数据
   */
  const clearCommissionData = useCallback(() => {
    setCommissionData([]);
    setCommissionLoaded(false);
    localStorage.removeItem("ozon_commission_data");
    localStorage.removeItem("ozon_commission_mappings"); // 🔹 清除映射历史
  }, []);

  /**
   * 清除物流数据
   */
  const clearShippingData = useCallback(() => {
    setShippingData([]);
    setShippingLoaded(false);
    localStorage.removeItem("ozon_shipping_data");
    localStorage.removeItem("ozon_shipping_mappings"); // 🔹 清除映射历史
  }, []);

  /**
   * 更新列映射配置
   */
  const updateColumnMapping = useCallback((type: "commission" | "shipping", mapping: Record<string, number>) => {
    setColumnMapping((prev) => {
      const newMapping = { ...prev, [type]: mapping };
      safeLocalStorageSet("ozon_column_mapping", JSON.stringify(newMapping));
      return newMapping;
    });
  }, []);

  /**
   * 🔹 更新拦截配置（保存用户开关状态到 localStorage）
   */
  const updateInterceptionConfig = useCallback((config: Record<string, boolean>) => {
    setInterceptionConfig(config);
    safeLocalStorageSet("ozon_interception_config", JSON.stringify(config));
  }, []);

  const getCategories = useCallback(() => {
    const map = new Map<string, Map<string, Set<string>>>();
    commissionData.forEach((item) => {
      if (!map.has(item.primaryCategory)) {
        map.set(item.primaryCategory, new Map());
      }
      const secondaryMap = map.get(item.primaryCategory)!;
      if (!secondaryMap.has(item.secondaryCategory)) {
        secondaryMap.set(item.secondaryCategory, new Set());
      }
      if (item.tertiaryCategory) {
        secondaryMap.get(item.secondaryCategory)!.add(item.tertiaryCategory);
      }
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
      .map(([primary, secondaryMap]) => ({
        primary,
        secondary: Array.from(secondaryMap.entries())
          .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
          .map(([name, tertiarySet]) => ({
            name,
            tertiary: Array.from(tertiarySet).sort((a, b) => a.localeCompare(b, "zh-CN")),
          })),
      }));
  }, [commissionData]);

  const getCommissionByCategory = useCallback(
    (primary: string, secondary: string, tertiary?: string) => {
      const normalizedPrimary = normalizeCommissionCategory(primary);
      const normalizedSecondary = normalizeCommissionCategory(secondary);
      const normalizedTertiary = tertiary ? normalizeCommissionCategory(tertiary) : "";
      if (normalizedTertiary) {
        const exact = commissionData.find(
          (item) =>
            normalizeCommissionCategory(item.primaryCategory) === normalizedPrimary &&
            normalizeCommissionCategory(item.secondaryCategory) === normalizedSecondary &&
            normalizeCommissionCategory(item.tertiaryCategory || "") === normalizedTertiary
        );
        if (exact) return exact;
      }
      return commissionData.find(
        (item) =>
          normalizeCommissionCategory(item.primaryCategory) === normalizedPrimary &&
          normalizeCommissionCategory(item.secondaryCategory) === normalizedSecondary &&
          (!tertiary || !item.tertiaryCategory)
      );
    },
    [commissionData]
  );

  const getShippingChannels = useCallback(
    (
      length: number,
      width: number,
      height: number,
      weight: number,
      priceRMB: number,
      rubPerCny: number,
      valueLimitCurrency: ValueLimitCurrency = "RMB",
      hasBattery: boolean = false, // 🔹 是否带电
      hasLiquid: boolean = false, // 🔹 是否带液体
      designatedProvider: string = "" // 🔹 指定物流商过滤
    ) => {
      const priceRUB = cnyToRub(priceRMB, rubPerCny);
      
      // 🔹 关键：排序尺寸 - 包裹可以旋转，比较最长边
      const productDims = [length, width, height].sort((a, b) => b - a);
      const pLongest = productDims[0];  // 最长边
      const pMiddle = productDims[1];  // 中间边
      const pShortest = productDims[2]; // 最短边
      const sumDim = length + width + height;
      
      // 计算体积重
      const calculateVolWeight = (channel: ShippingChannel): number => {
        if (!channel.volumetricDivisor || channel.volumetricDivisor === 0) return 0;
        return (length * width * height / channel.volumetricDivisor) * 1000;
      };
      
      const available: ShippingChannel[] = [];
      const unavailable: UnavailableShippingChannel[] = [];

      shippingData.forEach((channel) => {
        const reasons: string[] = [];
        const interceptionReasons: ShippingInterceptionReason[] = [];
        
        // 🔹 预过滤：指定物流商（支持逗号分隔的多个物流商）
        if (designatedProvider) {
          const providerList = designatedProvider.split(",").map(p => p.trim()).filter(Boolean);
          if (providerList.length > 0 && !providerList.includes(channel.thirdParty)) {
            unavailable.push({ 
              ...channel, 
              reason: `指定物流商: ${providerList.join(", ")}`,
              interceptionReasons: [] 
            });
            return;
          }
        }
        
        // ========== 六维绝对拦截引擎（读取 interceptionConfig 判断是否启用） ==========
        
        // 维度一：货值拦截 (Value Limit)
        const rmbLimit = {
          currency: "RMB" as const,
          min: normalizeLimitValue(channel.minValue),
          max: normalizeLimitValue(channel.maxValue),
          price: priceRMB,
          symbol: "¥",
        };
        const rubLimit = {
          currency: "RUB" as const,
          min: normalizeLimitValue(channel.minValueRUB),
          max: normalizeLimitValue(channel.maxValueRUB),
          price: priceRUB,
          symbol: "₽",
        };
        const preferredLimit = valueLimitCurrency === "RMB" ? rmbLimit : rubLimit;
        const fallbackLimit = valueLimitCurrency === "RMB" ? rubLimit : rmbLimit;
        const activeLimit =
          preferredLimit.min !== undefined || preferredLimit.max !== undefined
            ? preferredLimit
            : fallbackLimit.min !== undefined || fallbackLimit.max !== undefined
              ? fallbackLimit
              : null;

        if (activeLimit) {
          const min = activeLimit.min;
          const max = activeLimit.max;
          const current = activeLimit.price;
          const unit = activeLimit.symbol;
          const usedFallback = activeLimit.currency !== valueLimitCurrency;
          const fallbackText = usedFallback ? "（所选口径缺失，使用备用货值口径）" : "";
          const rangeText = `${min !== undefined ? `${unit}${min}` : "无下限"}-${max !== undefined ? `${unit}${max}` : "无上限"}`;

          if ((min !== undefined && current < min) || (max !== undefined && current > max)) {
            const code = min !== undefined && current < min ? "VALUE_TOO_LOW" : "VALUE_LIMIT";
            const message = min !== undefined && current < min ? "商品售价低于渠道货值下限" : "商品售价超出渠道货值上限";
            reasons.push(`❌ 货值不符: ${unit}${current.toFixed(activeLimit.currency === "RMB" ? 2 : 0)} 不在 ${rangeText} 范围${fallbackText}`);
            interceptionReasons.push({
              dimension: "货值",
              code,
              message,
              details: `当前 ${unit}${current.toFixed(activeLimit.currency === "RMB" ? 2 : 0)} 不在 ${rangeText} 范围内${fallbackText}`
            });
          }
        }
        
        // 维度二：物理实重拦截 (Actual Weight Limit) - 仅当启用时
        if (interceptionConfig.minWeight !== false || interceptionConfig.maxWeight !== false) {
          if (weight < channel.minWeight) {
            reasons.push(`🚫 实重不足: ${weight}g < ${channel.minWeight}g (最低起重要求)`);
            interceptionReasons.push({
              dimension: "实重",
              code: "WEIGHT_TOO_LOW",
              message: `低于最小起重要求`,
              details: `商品 ${weight}g < 渠道最小 ${channel.minWeight}g`
            });
          }
          if (weight > channel.maxWeight) {
            reasons.push(`🚫 实重超限: ${weight}g > ${channel.maxWeight}g`);
            interceptionReasons.push({
              dimension: "实重",
              code: "WEIGHT_TOO_HIGH",
              message: `超过最大实重限制`,
              details: `商品 ${weight}g > 渠道最大 ${channel.maxWeight}g`
            });
          }
        }
        
        // 维度三：绝对边长拦截 (Edge Length Limit) - 排序后比较 - 仅当启用时
        if (interceptionConfig.maxLength !== false || interceptionConfig.maxSumDimension !== false) {
          const channelDims = [channel.maxLength || 0, channel.maxWidth || 0, channel.maxHeight || 0].sort((a, b) => b - a);
          const cLongest = channelDims[0];
          const cMiddle = channelDims[1];
          const cShortest = channelDims[2];
          
          if (interceptionConfig.maxLength !== false) {
            if (pLongest > cLongest) {
              reasons.push(`🚫 单边超限: 商品最长边 ${pLongest}cm > 渠道限制 ${cLongest}cm`);
              interceptionReasons.push({
                dimension: "边长",
                code: "EDGE_TOO_LONG",
                message: `单边尺寸超限（包裹可旋转）`,
                details: `商品最长边 ${pLongest}cm > 渠道 ${cLongest}cm`
              });
            }
            if (pMiddle > cMiddle) {
              reasons.push(`🚫 单边超限: 商品中间边 ${pMiddle}cm > 渠道限制 ${cMiddle}cm`);
              interceptionReasons.push({
                dimension: "边长",
                code: "EDGE_TOO_LONG",
                message: `单边尺寸超限（包裹可旋转）`,
                details: `商品中间边 ${pMiddle}cm > 渠道 ${cMiddle}cm`
              });
            }
            if (pShortest > cShortest) {
              reasons.push(`🚫 单边超限: 商品最短边 ${pShortest}cm > 渠道限制 ${cShortest}cm`);
              interceptionReasons.push({
                dimension: "边长",
                code: "EDGE_TOO_LONG",
                message: `单边尺寸超限（包裹可旋转）`,
                details: `商品最短边 ${pShortest}cm > 渠道 ${cShortest}cm`
              });
            }
          }
          
          // 维度四：尺寸总和拦截 (Sum of Dimensions Limit) - 仅当启用时
          if (interceptionConfig.maxSumDimension !== false && sumDim > channel.maxSumDimension) {
            reasons.push(`🚫 尺寸总和超限: ${sumDim}cm > ${channel.maxSumDimension}cm`);
            interceptionReasons.push({
              dimension: "尺寸总和",
              code: "SUM_DIMENSION_EXCEEDED",
              message: `长宽高之和超过限制`,
              details: `${sumDim}cm > 渠道 ${channel.maxSumDimension}cm`
            });
          }
        }
        
        // 维度五：体积重拦截 (Volume Weight Limit) - 仅当启用时
        if (interceptionConfig.volumetricDivisor !== false) {
          const volWeight = calculateVolWeight(channel);
          if (volWeight > (channel.maxWeight * 0.8)) { // 接近上限时预警
            reasons.push(`⚠️ 体积重警告: ${volWeight.toFixed(0)}g (接近上限)`);
          }
        }
        
        // 维度六：特殊属性拦截 (Attribute Limit) - 仅当启用时
        if (interceptionConfig.batteryAllowed !== false && hasBattery && !channel.batteryAllowed) {
          reasons.push(`🚫 电池拦截: 该渠道禁运带电产品`);
          interceptionReasons.push({
            dimension: "电池",
            code: "BATTERY_NOT_ALLOWED",
            message: `该渠道禁止带电商品`,
            details: `商品带电，渠道不允许`
          });
        }
        if (interceptionConfig.liquidAllowed !== false && hasLiquid && !channel.liquidAllowed) {
          reasons.push(`🚫 液体拦截: 该渠道禁运带液产品`);
          interceptionReasons.push({
            dimension: "液体",
            code: "LIQUID_NOT_ALLOWED",
            message: `该渠道禁止带液体商品`,
            details: `商品带液，渠道不允许`
          });
        }

        if (reasons.length > 0) {
          unavailable.push({ 
            ...channel, 
            reason: reasons.join(" | "),
            interceptionReasons
          });
        } else {
          available.push(channel);
        }
      });

      // 🔴 移除内部排序：由调用方（page.tsx）统一按用户选择的排序模式排序
      // 原逻辑在此处按运费排序，与 page.tsx 的 sortedAvailableChannels 重复

      return { available, unavailable };
    },
    [shippingData, interceptionConfig]
  );

  return (
    <DataHubContext.Provider
      value={{
        commissionData,
        shippingData,
        commissionLoaded,
        shippingLoaded,
        columnMapping,
        lastImportSummary,
        loadCommissionData,
        loadShippingData,
        clearCommissionData,
        clearShippingData,
        updateColumnMapping,
        updateInterceptionConfig, // 🔹 新增
        interceptionConfig, // 🔹 新增
        getCategories,
        getCommissionByCategory,
        getShippingChannels,
      }}
    >
      {children}
    </DataHubContext.Provider>
  );
}

export function useDataHub() {
  const context = useContext(DataHubContext);
  if (!context) {
    throw new Error("useDataHub must be used within a DataHubProvider");
  }
  return context;
}

/**
 * 计算体积重 (g)
 * 公式: L × W × H / divisor × 1000
 * @param length 长度 (cm)
 * @param width 宽度 (cm)
 * @param height 高度 (cm)
 * @param divisor 除数（默认12000）
 */
function calculateChannelVolumetricWeight(
  length: number,
  width: number,
  height: number,
  divisor: number = 12000
): number {
  return ((length * width * height) / divisor) * 1000;
}

/**
 * 解析物流渠道的体积重除数
 * 从 volumetricDivisor 字段获取，或从 billingType 解析除数
 * 强制兜底：如果解析结果 < 1000，一定是错了，强制回退到 12000
 */
function parseVolumetricDivisor(channel: ShippingChannel): number {
  // 🔴 修复：移除空格后再检查，防止 "12 000" 被截断为 12
  const cleanDivisor = String(channel.volumetricDivisor || "").replace(/[\s,]/g, "");
  const parsedFromField = parseInt(cleanDivisor) || 0;
  
  if (parsedFromField >= 1000) {
    return parsedFromField;
  }
  
  // 否则尝试从 billingType 解析除数
  const billingType = channel.billingType || "";
  const cleanBillingType = billingType.replace(/[\s,]/g, "");  // 移除空格
  
  // 常见除数模式匹配
  const divisorPatterns = [
    /÷(\d+)/,           // ÷12000
    /\/(\d+)/,           // /12000
    /(\d{4,5})/,        // 12000, 6000, 5000
  ];
  
  for (const pattern of divisorPatterns) {
    const match = cleanBillingType.match(pattern);
    if (match) {
      const divisor = parseInt(match[1]);
      if (divisor >= 1000 && divisor <= 20000) {
        return divisor;
      }
    }
  }
  
  // 🔴 强制兜底：默认 12000
  return 12000;
}

/**
 * 解析计费类型并计算计费重量
 * 
 * @returns 包含以下信息:
 * - billingWeight: 计费重量 (g)
 * - actualWeight: 实际重量 (g)
 * - volumetricWeight: 体积重 (g)
 * - isVolumetric: 是否按体积重计费
 * - divisor: 体积重除数
 * - billingType: 计费类型描述
 */
export function parseBillingWeight(
  channel: ShippingChannel,
  length: number,
  width: number,
  height: number,
  actualWeight: number
): {
  billingWeight: number;
  actualWeight: number;
  volumetricWeight: number;
  isVolumetric: boolean;
  divisor: number;
  billingType: string;
} {
  const billingTypeRaw = channel.billingType || "实际重量";
  const divisor = parseVolumetricDivisor(channel);
  
  // 🔴 安全检查：如果除数异常（< 1000），强制使用 12000
  const safeDivisor = divisor < 1000 ? 12000 : divisor;
  
  // 计算体积重 (g)
  const volumetricWeight = ((length * width * height) / safeDivisor) * 1000;
  
  // 🔴 关键修复：实时判定计抛，使用 Math.round 防止浮点误差
  const isActuallyVolumetric = Math.round(volumetricWeight) > Math.round(actualWeight);
  
  // 根据计费类型确定计费重量
  let billingWeight: number;
  let isVolumetric: boolean;
  let billingTypeDesc: string;
  
  const normalizedBillingType = billingTypeRaw.toLowerCase();
  
  if (
    normalizedBillingType.includes("最大") || 
    normalizedBillingType.includes("取大") ||
    normalizedBillingType.includes("max")
  ) {
    // 最大/取大: 取实重和体积重的最大值
    billingWeight = Math.max(actualWeight, volumetricWeight);
    isVolumetric = isActuallyVolumetric;  // 🔴 使用实时判定
    billingTypeDesc = "取大";
  } else if (
    normalizedBillingType.includes("体积") && 
    !normalizedBillingType.includes("实际")
  ) {
    // 纯体积: 只按体积重计费
    billingWeight = volumetricWeight;
    isVolumetric = true;
    billingTypeDesc = "体积重";
  } else if (
    normalizedBillingType.includes("实际") &&
    !normalizedBillingType.includes("最大") &&
    !normalizedBillingType.includes("取大")
  ) {
    // 纯实际: 只按实际重量计费
    billingWeight = actualWeight;
    isVolumetric = false;
    billingTypeDesc = "实际重";
  } else {
    // 默认行为: 取大
    billingWeight = Math.max(actualWeight, volumetricWeight);
    isVolumetric = isActuallyVolumetric;  // 🔴 使用实时判定
    billingTypeDesc = "取大";
  }
  
  return {
    billingWeight,
    actualWeight,
    volumetricWeight,
    isVolumetric,
    divisor: safeDivisor,
    billingType: billingTypeDesc,
  };
}

/**
 * 获取计费模式描述
 */
export function getBillingModeDescription(channel: ShippingChannel): string {
  const billingTypeRaw = channel.billingType || "实际重量";
  const normalizedBillingType = billingTypeRaw.toLowerCase();
  
  if (normalizedBillingType.includes("最大") || normalizedBillingType.includes("取大")) {
    return "取大";
  } else if (normalizedBillingType.includes("体积") && !normalizedBillingType.includes("实际")) {
    return "体积重";
  } else if (normalizedBillingType.includes("实际")) {
    return "实际重";
  }
  
  return "取大";
}

/**
 * 计算物流费用（RMB）
 * 严格执行单位转换: pricePerKg / 1000 = 每克单价
 * 
 * @param channel 物流渠道
 * @param chargeableWeight 计费重量 (g) - 由调用方根据计费类型计算
 */
export function calculateShippingCost(
  channel: ShippingChannel, 
  chargeableWeight: number,
  length?: number,
  width?: number,
  height?: number,
  actualWeight?: number
): number {
  // 🔴 关键修复：直接使用 varFeePerGram（每克运费），不转换
  const varFeePerGram = channel.varFeePerGram;
  
  // 如果提供了尺寸和实际重量，说明调用方需要体积重计算
  if (length !== undefined && width !== undefined && height !== undefined && actualWeight !== undefined) {
    const { billingWeight } = parseBillingWeight(channel, length, width, height, actualWeight);
    return channel.fixFee + varFeePerGram * billingWeight;
  }
  
  // 兼容旧调用方式：直接使用传入的重量作为计费重量
  return channel.fixFee + varFeePerGram * chargeableWeight;
}

/**
 * 获取每克单价（用于UI显示）
 */
export function getPricePerGram(channel: ShippingChannel): number {
  return channel.varFeePerGram;
}
