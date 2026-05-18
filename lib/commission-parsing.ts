import type { CategoryCommission } from "./types";

export interface CommissionColumnMapping {
  primaryCategory: number;
  secondaryCategory: number;
  tier1Rate: number;
  tier2Rate: number;
  tier3Rate: number;
}

const EMPTY_MAPPING: CommissionColumnMapping = {
  primaryCategory: -1,
  secondaryCategory: -1,
  tier1Rate: -1,
  tier2Rate: -1,
  tier3Rate: -1,
};

export function normalizeCommissionText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()【】[\]{}，,。:：;；/\\|_]/g, "");
}

export function parseCommissionPercent(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw || raw === "-") return undefined;

  const numeric = Number.parseFloat(raw.replace(",", ".").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(numeric)) return undefined;

  return !raw.includes("%") && numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
}

export function findCommissionHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const normalizedCells = rows[i].map(normalizeCommissionText);
    const joined = normalizedCells.join(" ");
    const hasPrimary = normalizedCells.some((cell) =>
      cell.includes("一级类目") ||
      cell.includes("主类目") ||
      cell.includes("primarycategory") ||
      cell === "category"
    );
    const hasSecondary = normalizedCells.some((cell) =>
      cell.includes("二级类目") ||
      cell.includes("子类目") ||
      cell.includes("secondarycategory") ||
      cell.includes("subcategory")
    );
    const hasRate = joined.includes("佣金") || joined.includes("费率") || joined.includes("rate") || joined.includes("tariff") || joined.includes("тариф");

    if ((hasPrimary && hasSecondary) || (hasPrimary && hasRate)) {
      return i;
    }
  }

  return -1;
}

function normalizeOverride(mappingOverride?: Record<string, number>): Partial<CommissionColumnMapping> {
  if (!mappingOverride) return {};

  return {
    primaryCategory: mappingOverride.primaryCategory,
    secondaryCategory: mappingOverride.secondaryCategory,
    tier1Rate: mappingOverride.tier1Rate ?? mappingOverride.tier1,
    tier2Rate: mappingOverride.tier2Rate ?? mappingOverride.tier2,
    tier3Rate: mappingOverride.tier3Rate ?? mappingOverride.tier3,
  };
}

function isRateHeader(header: string): boolean {
  return (
    header.includes("佣金") ||
    header.includes("费率") ||
    header.includes("rate") ||
    header.includes("tariff") ||
    header.includes("тариф") ||
    header.includes("%")
  );
}

export function findCommissionColumns(headers: string[], mappingOverride?: Record<string, number>): CommissionColumnMapping {
  const mapping = { ...EMPTY_MAPPING, ...normalizeOverride(mappingOverride) };
  const normalized = headers.map(normalizeCommissionText);

  for (let i = 0; i < normalized.length; i++) {
    const h = normalized[i];
    if (mapping.primaryCategory === -1 && (h.includes("一级类目") || h.includes("主类目") || h.includes("primarycategory"))) {
      mapping.primaryCategory = i;
    }
    if (mapping.secondaryCategory === -1 && (h.includes("二级类目") || h.includes("子类目") || h.includes("secondarycategory") || h.includes("subcategory"))) {
      mapping.secondaryCategory = i;
    }
  }

  const rateColumns: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const h = normalized[i];
    if (!isRateHeader(h)) continue;

    rateColumns.push(i);
    const has1500 = h.includes("1500");
    const has5000 = h.includes("5000");
    const has0 = h.includes("0");
    const hasPlus = h.includes("+") || h.includes("plus") || h.includes(">") || h.includes("以上") || h.includes("более");

    if (mapping.tier1Rate === -1 && has0 && has1500 && !has5000) {
      mapping.tier1Rate = i;
    }
    if (mapping.tier2Rate === -1 && has1500 && has5000 && !hasPlus) {
      mapping.tier2Rate = i;
    }
    if (mapping.tier3Rate === -1 && has5000 && (hasPlus || !has1500)) {
      mapping.tier3Rate = i;
    }
  }

  if (rateColumns.length >= 3) {
    if (mapping.tier1Rate === -1) mapping.tier1Rate = rateColumns[0];
    if (mapping.tier2Rate === -1) mapping.tier2Rate = rateColumns[1];
    if (mapping.tier3Rate === -1) mapping.tier3Rate = rateColumns[2];
  } else if (rateColumns.length === 1) {
    if (mapping.tier1Rate === -1) mapping.tier1Rate = rateColumns[0];
    if (mapping.tier2Rate === -1) mapping.tier2Rate = rateColumns[0];
    if (mapping.tier3Rate === -1) mapping.tier3Rate = rateColumns[0];
  }

  return mapping;
}

export function parseCommissionRows(rawRows: string[][], mappingOverride?: Record<string, number>): CategoryCommission[] {
  const headerIdx = findCommissionHeaderRow(rawRows);
  if (headerIdx === -1) {
    throw new Error("无法找到佣金表的真实表头行（需要包含「一级类目」和「二级类目」）");
  }

  const headers = rawRows[headerIdx];
  const columns = findCommissionColumns(headers, mappingOverride);
  if (columns.primaryCategory === -1 || columns.secondaryCategory === -1) {
    throw new Error("佣金表缺少必要的类目列");
  }
  if (columns.tier1Rate === -1 || columns.tier2Rate === -1 || columns.tier3Rate === -1) {
    throw new Error("佣金表缺少三段佣金率列（0-1500、1500-5000、5000+）");
  }

  return rawRows.slice(headerIdx + 1).flatMap((row): CategoryCommission[] => {
    const primary = row[columns.primaryCategory]?.trim();
    const secondary = row[columns.secondaryCategory]?.trim();
    if (!primary || !secondary) return [];

    const rate1 = parseCommissionPercent(row[columns.tier1Rate]);
    const rate2 = parseCommissionPercent(row[columns.tier2Rate]);
    const rate3 = parseCommissionPercent(row[columns.tier3Rate]);
    if (rate1 === undefined || rate2 === undefined || rate3 === undefined) return [];

    return [{
      primaryCategory: primary,
      secondaryCategory: secondary,
      tiers: [
        { min: 0, max: 1500, rate: rate1 },
        { min: 1500.01, max: 5000, rate: rate2 },
        { min: 5000.01, max: Infinity, rate: rate3 },
      ],
    }];
  });
}

export function normalizeCommissionCategory(value: string): string {
  return normalizeCommissionText(value).replace(/[、·.\-—–]/g, "");
}
