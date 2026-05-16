export type ValueLimitCurrency = "RMB" | "RUB";

export const DEFAULT_RUB_PER_CNY = 12;

export function normalizeRubPerCny(rate: number | undefined | null): number {
  const parsed = Number(rate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUB_PER_CNY;
}

export function cnyToRub(valueCny: number, rubPerCny: number): number {
  return valueCny * normalizeRubPerCny(rubPerCny);
}

export function rubToCny(valueRub: number, rubPerCny: number): number {
  return valueRub / normalizeRubPerCny(rubPerCny);
}

