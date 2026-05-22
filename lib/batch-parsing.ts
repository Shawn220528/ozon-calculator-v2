import Papa from "papaparse";
import type { CalculationInput } from "./types";

export interface BatchInputRow extends Partial<CalculationInput> {
  sku?: string;
}

export interface BatchParseResult {
  rows: BatchInputRow[];
  errors: string[];
}

function parseNumeric(value: string): number {
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  if (!normalized) return 0;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseYesNo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "是" || normalized === "yes" || normalized === "true" || normalized === "1";
}

export function parseBatchInput(csvContent: string): BatchParseResult {
  const parsed = Papa.parse<string[]>(csvContent, {
    header: false,
    skipEmptyLines: true,
  });

  const errors = parsed.errors.map((error) => `第 ${error.row ?? "?"} 行 CSV 解析失败：${error.message}`);
  const data = parsed.data.filter((row) => row.some((cell) => String(cell || "").trim() !== ""));
  if (data.length < 2) {
    return { rows: [], errors };
  }

  const headers = data[0].map((header) => String(header || "").trim());
  const rows: BatchInputRow[] = [];

  for (let i = 1; i < data.length; i++) {
    const values = data[i];
    if (values.length > headers.length) {
      errors.push(`第 ${i + 1} 行列数超过表头，可能存在未加引号的逗号。`);
      continue;
    }

    const row: BatchInputRow = {};
    headers.forEach((header, idx) => {
      const value = String(values[idx] || "").trim();
      const key = header.toLowerCase();

      if (key.includes("sku") || key.includes("编号")) {
        row.sku = value;
        return;
      }
      if (key.includes("长度")) row.length = parseNumeric(value);
      else if (key.includes("宽度")) row.width = parseNumeric(value);
      else if (key.includes("高度")) row.height = parseNumeric(value);
      else if (key.includes("重量")) row.weight = parseNumeric(value);
      else if (key.includes("采购")) row.purchaseCost = parseNumeric(value);
      else if (key.includes("头程")) row.domesticShipping = parseNumeric(value);
      else if (key.includes("包装")) row.packagingFee = parseNumeric(value);
      else if (key.includes("带电")) row.hasBattery = parseYesNo(value);
      else if (key.includes("液体")) row.hasLiquid = parseYesNo(value);
      else if (key.includes("售价")) row.targetPriceRMB = parseNumeric(value);
      else if (key.includes("一级")) row.primaryCategory = value;
      else if (key.includes("二级")) row.secondaryCategory = value;
      else if (key.includes("三级")) row.tertiaryCategory = value;
    });

    const missingCore: string[] = [];
    if (!row.primaryCategory) missingCore.push("一级类目");
    if (!row.secondaryCategory) missingCore.push("二级类目");
    if (!row.targetPriceRMB) missingCore.push("目标售价");
    if (!row.weight) missingCore.push("重量");
    if (missingCore.length > 0) {
      errors.push(`第 ${i + 1} 行缺少核心字段：${missingCore.join("、")}`);
    }

    if (row.primaryCategory || row.targetPriceRMB || row.sku) {
      rows.push(row);
    }
  }

  return { rows, errors };
}
