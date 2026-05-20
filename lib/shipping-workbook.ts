const SKIP_ROW_TOKENS = new Set(["переход", "transition", "跳转", "h"]);

function normalizeSheetName(name: string): string {
  return String(name || "").trim().toLowerCase();
}

function isRoutingSheet(name: string): boolean {
  const normalized = normalizeSheetName(name);
  return normalized.includes("routing") || normalized.includes("路由") || normalized.includes("sla");
}

function isMainChineseRfbsSheet(name: string): boolean {
  const normalized = normalizeSheetName(name);
  return normalized.includes("中国") && normalized.includes("rfbs") && !isRoutingSheet(name);
}

function isMainEnglishRfbsSheet(name: string): boolean {
  const normalized = normalizeSheetName(name);
  return normalized.includes("china") && normalized.includes("rfbs") && !isRoutingSheet(name);
}

export function selectShippingSheetName(sheetNames: string[]): string | undefined {
  return (
    sheetNames.find((name) => normalizeSheetName(name) === "中国 rfbs") ||
    sheetNames.find((name) => normalizeSheetName(name) === "china rfbs") ||
    sheetNames.find(isMainChineseRfbsSheet) ||
    sheetNames.find(isMainEnglishRfbsSheet) ||
    sheetNames.find((name) => normalizeSheetName(name).includes("список") || normalizeSheetName(name).includes("3pl")) ||
    sheetNames[0]
  );
}

export function isSkippableShippingRow(row: string[], name: string): boolean {
  const normalizedName = String(name || "").trim().toLowerCase();
  if (!normalizedName || normalizedName === "-") return true;
  if (SKIP_ROW_TOKENS.has(normalizedName)) return true;

  const nonEmptyCells = row
    .map((cell) => String(cell || "").trim().toLowerCase())
    .filter(Boolean);
  if (nonEmptyCells.length < 4) return true;

  const transitionLikeCount = nonEmptyCells.filter((cell) => SKIP_ROW_TOKENS.has(cell)).length;
  return transitionLikeCount >= Math.max(3, Math.floor(nonEmptyCells.length * 0.6));
}
