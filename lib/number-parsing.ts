/**
 * Parse localized spreadsheet numbers.
 *
 * Ozon exports mix English thousands separators ("30,000"),
 * European decimals ("0,03432"), and plain decimals ("30.5").
 */
export function parseEuropeanNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (value === null || value === undefined) return 0;

  let text = String(value).trim();
  if (!text || text === "-") return 0;

  text = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, "")
    .replace(/[^\d,.\-]/g, "");

  if (!text || text === "-") return 0;

  const commaCount = (text.match(/,/g) || []).length;
  const dotCount = (text.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount > 0) {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    text = lastComma > lastDot
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (commaCount > 0) {
    const thousandsPattern = /^-?\d{1,3}(,\d{3})+$/;
    text = thousandsPattern.test(text) ? text.replace(/,/g, "") : text.replace(",", ".");
  } else if (dotCount > 1) {
    const thousandsPattern = /^-?\d{1,3}(\.\d{3})+$/;
    text = thousandsPattern.test(text) ? text.replace(/\./g, "") : text.replace(/\.(?=.*\.)/g, "");
  }

  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

