import { cnyToRub } from "./currency";

export interface OzonBackendPricing {
  isValid: boolean;
  frontPriceRMB: number;
  frontPriceRUB: number;
  ozonBackendPriceRMB: number;
  ozonBackendPriceRUB: number;
  ozonOriginalPriceRMB: number;
  ozonOriginalPriceRUB: number;
}

function roundRmb(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRub(value: number): number {
  return Math.round(value);
}

export function calculateOzonBackendPricing(frontPriceRMB: number, rubPerCny: number): OzonBackendPricing {
  const price = Number(frontPriceRMB);
  const rate = Number(rubPerCny);
  const isValid = Number.isFinite(price) && Number.isFinite(rate) && price > 0 && rate > 0;

  if (!isValid) {
    return {
      isValid: false,
      frontPriceRMB: 0,
      frontPriceRUB: 0,
      ozonBackendPriceRMB: 0,
      ozonBackendPriceRUB: 0,
      ozonOriginalPriceRMB: 0,
      ozonOriginalPriceRUB: 0,
    };
  }

  const backendRMB = roundRmb(price / 0.4);
  const originalRMB = roundRmb(backendRMB / 0.6);

  return {
    isValid: true,
    frontPriceRMB: roundRmb(price),
    frontPriceRUB: roundRub(cnyToRub(price, rate)),
    ozonBackendPriceRMB: backendRMB,
    ozonBackendPriceRUB: roundRub(cnyToRub(backendRMB, rate)),
    ozonOriginalPriceRMB: originalRMB,
    ozonOriginalPriceRUB: roundRub(cnyToRub(originalRMB, rate)),
  };
}
