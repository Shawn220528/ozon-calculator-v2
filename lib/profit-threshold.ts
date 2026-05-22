function roundDisplayPercent(value: number): number {
  return Number(value.toFixed(1));
}

export function isProfitMarginBelowThreshold(profitMargin: number, threshold: number): boolean {
  if (!Number.isFinite(profitMargin) || !Number.isFinite(threshold)) return false;
  return roundDisplayPercent(profitMargin) < roundDisplayPercent(threshold);
}

