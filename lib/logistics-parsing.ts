export interface ParsedRange {
  min: number;
  max: number;
  hasLimit: boolean;
}

export interface ParsedDeliveryTime {
  min: number;
  max: number;
  normalizedFromDate: boolean;
}

export function normalizeLimitValue(value: number | undefined): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0 || value >= 999999) {
    return undefined;
  }
  return value;
}

function normalizeRangeNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function normalizeNonNegativeNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

export function parseValueRange(valStr: string): ParsedRange {
  if (!valStr || valStr.trim() === "" || valStr.trim() === "-") {
    return { min: 0, max: 0, hasLimit: false };
  }

  const cleanStr = valStr.replace(/\s/g, "").replace(/,/g, "");
  const match = cleanStr.match(/(-?\d+(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    const first = normalizeRangeNumber(match[1]);
    const second = normalizeRangeNumber(match[2]);
    return { min: Math.min(first, second), max: Math.max(first, second), hasLimit: true };
  }

  const singleNum = cleanStr.match(/(-?\d+(?:\.\d+)?)/);
  if (singleNum) {
    return { min: 0, max: normalizeRangeNumber(singleNum[1]), hasLimit: true };
  }

  return { min: 0, max: 0, hasLimit: false };
}

export function parseDeliveryTime(timeStr: string): ParsedDeliveryTime {
  if (!timeStr || timeStr.trim() === "") {
    return { min: 20, max: 40, normalizedFromDate: false };
  }

  const normalizeRange = (a: number, b: number, normalizedFromDate = false): ParsedDeliveryTime => {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    if (min > 0 && max <= 120) {
      return { min, max, normalizedFromDate };
    }
    return { min: 20, max: 40, normalizedFromDate: false };
  };

  const value = String(timeStr).trim();
  const dateTokens = value.match(/\d+/g)?.map((token) => parseInt(token, 10)) || [];
  if (dateTokens.length >= 3) {
    const [first, second, third] = dateTokens;
    if (first >= 1900 && second >= 1 && second <= 120 && third >= 1 && third <= 120) {
      return normalizeRange(second, third, true);
    }
    if ((third >= 1900 || third <= 99) && first >= 1 && first <= 120 && second >= 1 && second <= 120) {
      return normalizeRange(first, second, true);
    }
  }

  const rangeMatch = value.match(/(-?\d{1,3})\s*(?:[-–—~至到]|\.{2})\s*(-?\d{1,3})/);
  if (rangeMatch) {
    return normalizeRange(parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10));
  }

  const chineseDateLike = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/);
  if (chineseDateLike) {
    return normalizeRange(parseInt(chineseDateLike[1], 10), parseInt(chineseDateLike[2], 10), true);
  }

  if (dateTokens.length === 2 && /[/.]/.test(value)) {
    return normalizeRange(dateTokens[0], dateTokens[1], true);
  }

  const singleNum = value.match(/-?\d{1,3}/);
  if (singleNum) {
    const days = parseInt(singleNum[0], 10);
    if (days > 0 && days <= 120) {
      return { min: days, max: days, normalizedFromDate: false };
    }
  }

  return { min: 20, max: 40, normalizedFromDate: false };
}

export function parseShippingRateString(rateStr: string): { fixFee: number; varFeePerGram: number } {
  if (!rateStr || rateStr.trim() === "-" || rateStr.trim() === "") {
    return { fixFee: 0, varFeePerGram: 0 };
  }

  const result = { fixFee: 0, varFeePerGram: 0 };
  let cleaned = rateStr
    .replace(/,/g, ".")
    .replace(/[¥￥$€₽]/gi, "")
    .replace(/rmb|cny|rub|rubles?|元|卢布/gi, "")
    .replace(/人民币|固定费|变动费|价格|费用|成本/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const varPatterns = [
    /(-?\d+\.?\d*)\s*\/\s*1\s*[gгкkg]/i,
    /(-?\d+\.?\d*)\s*\/\s*[gгкkg]/i,
    /(-?\d+\.?\d*)\s*(?:每|per)\s*[gгкkg]/i,
    /(-?\d+\.?\d*)\s*r?\s*b?\s*b?\s*\/\s*g/i,
  ];

  for (const pattern of varPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      result.varFeePerGram = normalizeNonNegativeNumber(match[1]);
      cleaned = cleaned.replace(pattern, "");
      break;
    }
  }

  const fixedMatch = cleaned.match(/(-?\d+\.?\d*)/);
  if (fixedMatch) {
    result.fixFee = normalizeNonNegativeNumber(fixedMatch[1]);
  }

  if (result.fixFee === 0 && result.varFeePerGram === 0) {
    const numbers = rateStr.replace(/,/g, ".").match(/-?\d+\.?\d*/g);
    if (numbers && numbers.length >= 1) {
      result.fixFee = normalizeNonNegativeNumber(numbers[0]);
      if (numbers.length >= 2) {
        result.varFeePerGram = normalizeNonNegativeNumber(numbers[1]);
      }
    }
  }

  return result;
}
