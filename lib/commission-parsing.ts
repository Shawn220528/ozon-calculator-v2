import type { CategoryCommission, CommissionTier, FulfillmentMode } from "./types";

export interface CommissionColumnMapping {
  primaryCategory: number;
  secondaryCategory: number;
  tertiaryCategory?: number;
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
  if (/inf(?:inity)?/i.test(raw)) return 0;

  const numeric = Number.parseFloat(raw.replace(",", ".").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(numeric)) return undefined;

  const percent = !raw.includes("%") && numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.min(100, Math.max(0, percent));
}

function createCommissionTiers(rate1: number, rate2: number, rate3: number): CommissionTier[] {
  return [
    { min: 0, max: 1500, rate: rate1 },
    { min: 1500.01, max: 5000, rate: rate2 },
    { min: 5000.01, max: Infinity, rate: rate3 },
  ];
}

function cleanCommissionLabel(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findNextHeaderIndex(headers: string[], startIndex: number, label: string): number {
  const target = normalizeCommissionText(label);
  for (let i = startIndex + 1; i < headers.length; i++) {
    if (normalizeCommissionText(headers[i]) === target) return i;
  }
  return -1;
}

function findOfficialTarifsHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const joined = rows[i].map(normalizeCommissionText).join(" ");
    if (
      joined.includes("rfbs") &&
      joined.includes("fbp") &&
      joined.includes("тариф") &&
      (joined.includes("mpcategory") || joined.includes("marcetplacecategory"))
    ) {
      return i;
    }
  }
  return -1;
}

function findOfficialTarifsColumns(headers: string[]) {
  const normalized = headers.map(normalizeCommissionText);
  const find = (predicate: (header: string, index: number) => boolean) => normalized.findIndex(predicate);

  const descriptiveTypeRu = find((header) => header === "descriptivetype");
  const descriptiveCategoryRu = find((header) => header === "descriptivecategory3");
  const mpCategoryRu = find((header) => header === "mpcategory" || header === "marcetplacecategory");
  const blockCategoryRu = find((header) => header.includes("блоккатегорий"));
  const brand = find((header) => header === "brand");

  const descriptiveTypeZh = descriptiveTypeRu >= 0 ? findNextHeaderIndex(headers, descriptiveTypeRu, "ZH") : -1;
  const descriptiveTypeEn = descriptiveTypeRu >= 0 ? findNextHeaderIndex(headers, descriptiveTypeRu, "EN") : -1;
  const descriptiveCategoryZh = descriptiveCategoryRu >= 0 ? findNextHeaderIndex(headers, descriptiveCategoryRu, "ZH") : -1;
  const descriptiveCategoryEn = descriptiveCategoryRu >= 0 ? findNextHeaderIndex(headers, descriptiveCategoryRu, "EN") : -1;
  const mpCategoryZh = mpCategoryRu >= 0 ? findNextHeaderIndex(headers, mpCategoryRu, "ZH") : -1;
  const mpCategoryEn = mpCategoryRu >= 0 ? findNextHeaderIndex(headers, mpCategoryRu, "EN") : -1;
  const blockCategoryZh = blockCategoryRu >= 0 ? findNextHeaderIndex(headers, blockCategoryRu, "ZH") : -1;
  const blockCategoryEn = blockCategoryRu >= 0 ? findNextHeaderIndex(headers, blockCategoryRu, "EN") : -1;

  const findRate = (mode: FulfillmentMode, tier: 1 | 2 | 3) =>
    find((header) => {
      if (!header.includes(mode.toLowerCase()) || !header.includes("тариф")) return false;
      const has1500 = header.includes("1500");
      const has5000 = header.includes("5000");
      const hasPlus = header.includes("+") || header.includes("plus") || header.includes("более");
      if (tier === 1) return has1500 && !has5000;
      if (tier === 2) return has1500 && has5000 && !hasPlus;
      return has5000 && (hasPlus || !has1500);
    });

  return {
    descriptiveTypeRu,
    descriptiveTypeZh,
    descriptiveTypeEn,
    descriptiveCategoryRu,
    descriptiveCategoryZh,
    descriptiveCategoryEn,
    mpCategoryRu,
    mpCategoryZh,
    mpCategoryEn,
    blockCategoryRu,
    blockCategoryZh,
    blockCategoryEn,
    brand,
    rfbs: [findRate("RFBS", 1), findRate("RFBS", 2), findRate("RFBS", 3)],
    fbp: [findRate("FBP", 1), findRate("FBP", 2), findRate("FBP", 3)],
  };
}

function readCell(row: string[], index: number): string {
  return index >= 0 ? cleanCommissionLabel(row[index]) : "";
}

function readRates(row: string[], indexes: number[]): number[] | null {
  const rates = indexes.map((index) => parseCommissionPercent(row[index]));
  return rates.every((rate): rate is number => rate !== undefined) ? rates : null;
}

function ratesKey(rates: number[] | undefined): string {
  return (rates || []).map((rate) => rate.toFixed(4)).join("/");
}

function commissionIdentityKey(item: CategoryCommission): string {
  return [
    normalizeCommissionCategory(item.primaryCategory),
    normalizeCommissionCategory(item.secondaryCategory),
    normalizeCommissionCategory(item.tertiaryCategory || ""),
    ratesKey(item.sourceMeta?.rfbsRates),
    ratesKey(item.sourceMeta?.fbpRates),
  ].join("|||");
}

function normalizeOfficialCategoryItems(items: CategoryCommission[]): CategoryCommission[] {
  const merged = new Map<string, CategoryCommission>();
  for (const item of items) {
    const key = commissionIdentityKey(item);
    if (!merged.has(key)) merged.set(key, item);
  }

  const deduped = Array.from(merged.values());
  const displayCounts = new Map<string, number>();
  for (const item of deduped) {
    const key = [
      normalizeCommissionCategory(item.primaryCategory),
      normalizeCommissionCategory(item.secondaryCategory),
      normalizeCommissionCategory(item.tertiaryCategory || ""),
    ].join("|||");
    displayCounts.set(key, (displayCounts.get(key) || 0) + 1);
  }

  const normalized = deduped.map((item) => {
    const key = [
      normalizeCommissionCategory(item.primaryCategory),
      normalizeCommissionCategory(item.secondaryCategory),
      normalizeCommissionCategory(item.tertiaryCategory || ""),
    ].join("|||");
    if ((displayCounts.get(key) || 0) <= 1) return item;

    const fallback =
      cleanCommissionLabel(item.sourceMeta?.descriptiveType) ||
      cleanCommissionLabel(item.sourceMeta?.brand) ||
      `源行${item.sourceMeta?.rowNumber || ""}`;
    const suffix = fallback && !item.tertiaryCategory?.includes(fallback) ? fallback : `源行${item.sourceMeta?.rowNumber || ""}`;
    return {
      ...item,
      tertiaryCategory: `${item.tertiaryCategory || item.secondaryCategory} / ${suffix}`,
      categoryPath: [item.primaryCategory, item.secondaryCategory, `${item.tertiaryCategory || item.secondaryCategory} / ${suffix}`],
    };
  });

  return normalized.sort((a, b) =>
    `${a.primaryCategory}\u0000${a.secondaryCategory}\u0000${a.tertiaryCategory || ""}`.localeCompare(
      `${b.primaryCategory}\u0000${b.secondaryCategory}\u0000${b.tertiaryCategory || ""}`,
      "zh-CN"
    )
  );
}

function parseOfficialTarifsRows(rawRows: string[][], headerIdx: number, sheetName?: string): CategoryCommission[] {
  const headers = rawRows[headerIdx];
  const columns = findOfficialTarifsColumns(headers);
  const hasFullDetail = columns.descriptiveTypeRu >= 0;
  const primaryIndex = hasFullDetail
    ? (columns.mpCategoryZh >= 0 ? columns.mpCategoryZh : columns.mpCategoryEn)
    : (columns.blockCategoryZh >= 0 ? columns.blockCategoryZh : columns.blockCategoryEn);
  const secondaryRootIndex = hasFullDetail
    ? (columns.descriptiveCategoryZh >= 0 ? columns.descriptiveCategoryZh : columns.descriptiveCategoryEn)
    : (columns.mpCategoryZh >= 0 ? columns.mpCategoryZh : columns.mpCategoryEn);
  const typeIndex = columns.descriptiveTypeZh >= 0 ? columns.descriptiveTypeZh : columns.descriptiveTypeEn;

  if (primaryIndex === -1 || secondaryRootIndex === -1) {
    throw new Error("官方 Tarifs 佣金表缺少类目列（MP Category / ZH / EN）");
  }
  if (columns.rfbs.some((index) => index === -1) || columns.fbp.some((index) => index === -1)) {
    throw new Error("官方 Tarifs 佣金表缺少 RFBS 或 FBP 三段佣金列");
  }

  const parsed = rawRows.slice(headerIdx + 1).flatMap((row, offset): CategoryCommission[] => {
    const primary = readCell(row, primaryIndex);
    const secondaryRoot = readCell(row, secondaryRootIndex);
    const descriptiveType = readCell(row, typeIndex);
    const brand = readCell(row, columns.brand) || "All";
    if (!primary || !secondaryRoot) return [];

    const rfbsRates = readRates(row, columns.rfbs);
    const fbpRates = readRates(row, columns.fbp);
    if (!rfbsRates || !fbpRates) return [];

    const tertiaryBase = hasFullDetail && descriptiveType ? descriptiveType : "";
    const tertiary = [tertiaryBase, brand && brand !== "All" ? brand : ""].filter(Boolean).join(" / ");

    const rfbsTiers = createCommissionTiers(rfbsRates[0], rfbsRates[1], rfbsRates[2]);
    const fbpTiers = createCommissionTiers(fbpRates[0], fbpRates[1], fbpRates[2]);

    return [{
      primaryCategory: primary,
      secondaryCategory: secondaryRoot,
      tertiaryCategory: tertiary || undefined,
      categoryPath: tertiary ? [primary, secondaryRoot, tertiary] : [primary, secondaryRoot],
      tiers: rfbsTiers,
      modeTiers: {
        RFBS: rfbsTiers,
        FBP: fbpTiers,
      },
      sourceMeta: {
        sheetName,
        rowNumber: headerIdx + offset + 2,
        marketplaceCategory: readCell(row, columns.mpCategoryZh >= 0 ? columns.mpCategoryZh : columns.mpCategoryEn),
        descriptiveCategory: secondaryRoot,
        descriptiveType: tertiaryBase,
        brand,
        rfbsRates,
        fbpRates,
      },
    }];
  });

  return normalizeOfficialCategoryItems(parsed);
}

export function selectCommissionSheetName(sheetNames: string[]): string | undefined {
  const full = sheetNames.find((name) => normalizeCommissionText(name) === "fullchinahk");
  if (full) return full;
  const mpTree = sheetNames.find((name) => normalizeCommissionText(name) === "mptreetarifscn");
  if (mpTree) return mpTree;
  return sheetNames[0];
}

export function findCommissionHeaderRow(rows: string[][]): number {
  const officialIdx = findOfficialTarifsHeaderRow(rows);
  if (officialIdx !== -1) return officialIdx;

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
    tertiaryCategory: mappingOverride.tertiaryCategory,
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
    if ((mapping.tertiaryCategory ?? -1) === -1 && (h.includes("三级类目") || h.includes("thirdcategory") || h.includes("tertiarycategory"))) {
      mapping.tertiaryCategory = i;
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

  if (findOfficialTarifsHeaderRow(rawRows) === headerIdx) {
    return parseOfficialTarifsRows(rawRows, headerIdx);
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
    const tertiary = columns.tertiaryCategory !== undefined && columns.tertiaryCategory >= 0 ? row[columns.tertiaryCategory]?.trim() : "";
    if (!primary || !secondary) return [];

    const rate1 = parseCommissionPercent(row[columns.tier1Rate]);
    const rate2 = parseCommissionPercent(row[columns.tier2Rate]);
    const rate3 = parseCommissionPercent(row[columns.tier3Rate]);
    if (rate1 === undefined || rate2 === undefined || rate3 === undefined) return [];

    const tiers = createCommissionTiers(rate1, rate2, rate3);
    return [{
      primaryCategory: primary,
      secondaryCategory: secondary,
      tertiaryCategory: tertiary || undefined,
      categoryPath: tertiary ? [primary, secondary, tertiary] : [primary, secondary],
      tiers,
      modeTiers: {
        RFBS: tiers,
        FBP: tiers,
      },
    }];
  });
}

export function parseCommissionWorkbookRows(rawRows: string[][], sheetName?: string, mappingOverride?: Record<string, number>): CategoryCommission[] {
  const headerIdx = findCommissionHeaderRow(rawRows);
  if (headerIdx !== -1 && findOfficialTarifsHeaderRow(rawRows) === headerIdx) {
    return parseOfficialTarifsRows(rawRows, headerIdx, sheetName);
  }
  return parseCommissionRows(rawRows, mappingOverride);
}

export function normalizeCommissionCategory(value: string): string {
  return normalizeCommissionText(value).replace(/[、·.\-—–]/g, "");
}
