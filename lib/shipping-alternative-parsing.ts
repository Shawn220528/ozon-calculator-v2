import type { ShippingChannel } from "./types";
import {
  parseDeliveryTime,
  parseShippingRateString,
} from "./logistics-parsing";

function generateShippingUniqueId(name: string, serviceLevel: string): string {
  const normalizedName = (name || "").trim().toLowerCase().replace(/\s+/g, "-");
  const normalizedLevel = (serviceLevel || "").trim().toLowerCase().replace(/\s+/g, "-");
  return `${normalizedName}_${normalizedLevel}`;
}

export function parseAlternativeShippingRows(rawRows: string[][]): ShippingChannel[] {
  const parsed: ShippingChannel[] = [];
  const idCounter = new Map<string, number>();

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.length < 10) continue;

    const name = row[1]?.trim();
    if (!name) continue;

    const rating = Number.parseFloat(row[2]) || 0;
    const time = parseDeliveryTime(row[3] || "");
    const { fixFee, varFeePerGram } = parseShippingRateString(row[4] || "");
    const serviceLevel = "";
    const baseId = generateShippingUniqueId(name, serviceLevel);
    const count = idCounter.get(baseId) || 0;
    const uniqueId = count > 0 ? `${baseId}_${count + 1}` : baseId;
    idCounter.set(baseId, count + 1);

    parsed.push({
      id: uniqueId,
      name,
      thirdParty: name.split(" ")[0] || "",
      serviceTier: "",
      serviceLevel,
      fixFee,
      varFeePerGram,
      pricePerKg: fixFee + varFeePerGram * 1000,
      pricePerCubic: 0,
      minWeight: 0,
      maxWeight: 999999,
      maxLength: 999,
      maxWidth: 999,
      maxHeight: 999,
      maxSumDimension: 9999,
      deliveryTimeMin: time.min,
      deliveryTimeMax: time.max,
      deliveryTime: Math.round((time.min + time.max) / 2),
      billingType: "实际重量",
      volumetricDivisor: 0,
      ozonRating: rating,
      batteryAllowed: row[6]?.includes("Разрешено") || false,
      liquidAllowed: false,
    });
  }

  return parsed;
}
