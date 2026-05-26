export type ValueLimitCurrency = "RMB" | "RUB";

export const DEFAULT_RUB_PER_CNY = 12;

export function normalizeRubPerCny(rate: number | undefined | null): number {
  const parsed = Number(rate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUB_PER_CNY;
}

export function normalizeExchangeRateBuffer(buffer: number | undefined | null): number {
  const parsed = Number(buffer);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
}

export function getRiskAdjustedRubPerCny(rate: number, buffer: number | undefined | null): number {
  const safeBuffer = normalizeExchangeRateBuffer(buffer);
  return normalizeRubPerCny(rate) * (1 + safeBuffer / 100);
}

export function getRiskAdjustedRevenueRMB(priceRMB: number, buffer: number | undefined | null): number {
  const parsedPrice = Number(priceRMB);
  const safePrice = Number.isFinite(parsedPrice) ? parsedPrice : 0;
  const safeBuffer = normalizeExchangeRateBuffer(buffer);
  return safePrice / (1 + safeBuffer / 100);
}

export function cnyToRub(valueCny: number, rubPerCny: number): number {
  return valueCny * normalizeRubPerCny(rubPerCny);
}

export function rubToCny(valueRub: number, rubPerCny: number): number {
  return valueRub / normalizeRubPerCny(rubPerCny);
}
