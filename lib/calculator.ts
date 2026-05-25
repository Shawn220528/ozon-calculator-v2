/**
* Ozon rFBS 跨境精算核心代数模型
* 严格遵循 PRD v2.1 RMB主导模式
* 
* 核心变量定义（RMB主导）：
*   P_rmb = 用户输入的售价 (RMB)
*   P_rub = P_rmb × exchangeRate  (exchangeRate = 1 CNY = X RUB)
*   E = exchangeRate (汇率: 1 CNY = X RUB)
 *   C = 平台佣金率(%)
 *   W = 提现手续费率(%)
 *   Acpa = CPA广告占比(%)
 *   Fcpc = CPC广告单均转化成本(RMB)
 *   Rcost = 单件分摊退货成本(RMB)
 *   Ftotal = 单件总固定成本(RMB)
 *   M = 有效边际贡献率 = (1 - C) * (1 - W) - Acpa - Pfee
 *
 * 终极公式：
 *   正向算利润：净利润(RMB) = P_rmb * M - Ftotal
 *   逆向算售价：P_rmb = (Ftotal + 目标利润) / M
 *               P_rub = P_rmb × E
 *   佣金匹配：必须用 P_rub 去匹配 Ozon 三个阶梯
 */

import { CalculationInput, CalculationResult, CategoryCommission, CommissionTier, FulfillmentMode, ShippingChannel, UnavailableShippingChannel } from "./types";
import { calculateShippingCost, parseBillingWeight } from "./data-hub-context";
import { cnyToRub, rubToCny } from "./currency";

function parseFiniteNumber(value: number, fallback: number): number {
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasCommissionTiers(tiers: CommissionTier[] | undefined): tiers is CommissionTier[] {
  return Array.isArray(tiers) && tiers.length > 0;
}

function normalizeTierMin(tier: CommissionTier): number {
  const parsed = parseFloat(String(tier.min));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTierMax(tier: CommissionTier): number {
  const rawMax = (tier as { max?: unknown }).max;
  if (rawMax === null || rawMax === undefined) return Infinity;
  const parsed = parseFloat(String(rawMax));
  return Number.isFinite(parsed) ? parsed : Infinity;
}

function normalizePercent(value: number, max: number = 100): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(0, parsed));
}

function normalizeShippingLimit(value: number | undefined): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value) && value > 0 && value < 999999
    ? value
    : undefined;
}

// 佣金阶梯边界常量（RUB）
const TIER_BOUNDARIES = [
  { min: 0, max: 1500 },
  { min: 1500.01, max: 5000 },
  { min: 5000.01, max: Infinity },
];

/**
 * 根据卢布售价获取对应阶梯的佣金率
 * 注意：佣金匹配始终用 P_rub
 */
export function getCommissionRate(
  commission: CategoryCommission,
  priceRUB: number,
  fulfillmentMode: FulfillmentMode = "RFBS"
): number {
  return getCommissionTierForPrice(commission, priceRUB, fulfillmentMode).rate;
}

export function getCommissionTiersForMode(
  commission: CategoryCommission,
  fulfillmentMode: FulfillmentMode = "RFBS"
): CommissionTier[] {
  const modeTiers = commission.modeTiers?.[fulfillmentMode];
  if (hasCommissionTiers(modeTiers)) return modeTiers;

  const rfbsTiers = commission.modeTiers?.RFBS;
  if (hasCommissionTiers(rfbsTiers)) return rfbsTiers;

  return hasCommissionTiers(commission.tiers) ? commission.tiers : [];
}

export function normalizeCommissionPriceRUB(priceRUB: number): number {
  if (!Number.isFinite(priceRUB)) return 0;
  return Math.round((priceRUB + Number.EPSILON) * 100) / 100;
}

export function getCommissionTierForPrice(
  commission: CategoryCommission,
  priceRUB: number,
  fulfillmentMode: FulfillmentMode = "RFBS"
): CommissionTier {
  const tiers = getCommissionTiersForMode(commission, fulfillmentMode);
  if (tiers.length === 0) {
    return { min: 0, max: Infinity, rate: 0 };
  }

  const normalizedPriceRUB = normalizeCommissionPriceRUB(priceRUB);

  for (const tier of tiers) {
    if (normalizedPriceRUB >= normalizeTierMin(tier) && normalizedPriceRUB <= normalizeTierMax(tier)) {
      return tier;
    }
  }

  const sortedTiers = [...tiers].sort((a, b) => normalizeTierMin(a) - normalizeTierMin(b));
  return sortedTiers.find((tier) => normalizedPriceRUB <= normalizeTierMax(tier)) || sortedTiers[sortedTiers.length - 1];
}

/**
 * 计算体积重 (g)
 * 公式：长×宽×高 / divisor × 1000 (单位: cm, 结果: g)
 * 
 * @param length 长度 (cm)
 * @param width 宽度 (cm)
 * @param height 高度 (cm)
 * @param divisor 除数（默认12000，常用值：12000, 6000, 5000）
 */
export function calculateVolumetricWeight(
  length: number,
  width: number,
  height: number,
  divisor: number = 12000
): number {
  return ((length * width * height) / divisor) * 1000;
}

/**
 * 获取计费重量 (g)
 * 
 * 如果提供了 shippingChannel，则使用 parseBillingWeight 正确计算计费类型（取大/体积重/实际重）
 * 否则回退到简化的取大逻辑（仅支持除数12000）
 * 
 * @param length 长度 (cm)
 * @param width 宽度 (cm)
 * @param height 高度 (cm)
 * @param actualWeight 实际重量 (g)
 * @param shippingChannel 可选的物流渠道（用于获取正确的除数和计费类型）
 */
export function getChargeableWeight(
  length: number,
  width: number,
  height: number,
  actualWeight: number,
  shippingChannel?: ShippingChannel
): { volumetric: number; chargeable: number; isVolumetric: boolean } {
  // 如果提供了物流渠道，使用 parseBillingWeight 获取正确的计费逻辑
  if (shippingChannel) {
    const result = parseBillingWeight(shippingChannel, length, width, height, actualWeight);
    return {
      volumetric: result.volumetricWeight,
      chargeable: result.billingWeight,
      isVolumetric: result.isVolumetric,
    };
  }
  
  // 兼容旧调用方式：使用默认除数12000，简单取大
  const volumetric = calculateVolumetricWeight(length, width, height);
  const chargeable = Math.max(volumetric, actualWeight);
  return {
    volumetric,
    chargeable,
    isVolumetric: volumetric > actualWeight,
  };
}

/**
 * 计算单件分摊退货成本 (RMB)
 */
export function calculateReturnCost(
  returnHandling: "destroy" | "resell" | "productOnly",
  returnRate: number,
  purchaseCost: number,
  domesticShipping: number,
  internationalShipping: number
): number {
  const rate = returnRate / 100;
  switch (returnHandling) {
    case "destroy":
      return (purchaseCost + domesticShipping + internationalShipping) * rate;
    case "resell":
      return internationalShipping * rate;
    case "productOnly":
      return purchaseCost * rate;
    default:
      return 0;
  }
}

/**
 * 计算 CPC 广告单均转化成本 (RMB)
 * bidCvr: F_cpc = 单次竞价(RUB) ÷ 转化率 ÷ RUB_PER_CNY
 * salesPercent: F_cpc = 当前售价(RMB) × 销售额目标百分比
 */
export function calculateCpcCost(
  cpcEnabled: boolean,
  cpcBid: number, // RUB
  cpcConversionRate: number, // 百分比
  exchangeRate: number, // RUB/CNY
  cpcBillingMode: CalculationInput["cpcBillingMode"] = "bidCvr",
  cpcSalesPercent: number = 0,
  priceRMB: number = 0
): number {
  if (!cpcEnabled) return 0;
  if (cpcBillingMode === "salesPercent") {
    if (cpcSalesPercent <= 0 || priceRMB <= 0) return 0;
    return priceRMB * (cpcSalesPercent / 100);
  }
  if (cpcConversionRate <= 0) return 0;
  const cvr = cpcConversionRate / 100;
  return rubToCny(cpcBid / cvr, exchangeRate);
}

function calculateInputCpcCost(input: CalculationInput, priceRMB: number = input.targetPriceRMB): number {
  return calculateCpcCost(
    input.cpcEnabled,
    input.cpcBid,
    input.cpcConversionRate,
    input.exchangeRate,
    input.cpcBillingMode || "bidCvr",
    input.cpcSalesPercent || 0,
    priceRMB
  );
}

/**
 * 计算 CPA 广告费 (RMB)
 * A_cpa = P_rmb × CPA占比
 * 注意：售价已经是 RMB，不需要再乘汇率
 */
export function calculateCpaCost(
  cpaEnabled: boolean,
  cpaRate: number, // 百分比
  priceRMB: number // RMB
): number {
  if (!cpaEnabled) return 0;
  return priceRMB * (cpaRate / 100);
}

/**
 * 计算有效边际贡献率 M
 * M = (1 - C) × (1 - W) - A_cpa - P_fee
 */
export function calculateMarginalContribution(
  commissionRate: number,
  withdrawalFee: number,
  cpaRate: number,
  paymentFee: number = 0
): number {
  const C = commissionRate / 100;
  const W = withdrawalFee / 100;
  const Acpa = cpaRate / 100;
  const Pfee = paymentFee / 100;
  return (1 - C) * (1 - W) - Acpa - Pfee;
}

/**
 * 核心：正向算利润 (RMB主导模式)
 * 净利润 (RMB) = P_rmb × M - F_total
 */
export function calculateNetProfit(
  priceRMB: number,
  marginalContribution: number,
  totalFixedCost: number
): number {
  return priceRMB * marginalContribution - totalFixedCost;
}

/**
 * 核心：逆向算售价 (RMB主导模式)
 * P_rmb = (F_total + 目标利润) / M
 * 返回 RMB 售价
 */
export function calculateRequiredPriceRMB(
  targetProfitRMB: number,
  marginalContribution: number,
  totalFixedCost: number
): number {
  if (marginalContribution <= 0) return Infinity;
  return (totalFixedCost + targetProfitRMB) / marginalContribution;
}

/**
 * 高阶逆向推价：根据目标利润率反推售价（含阶梯佣金迭代匹配）
 * 
 * 核心公式：P_rmb = F_total / (M - T_m)
 * 其中：
 *   T_m = 目标利润率（如 0.2 表示 20%）
 *   M = 有效边际贡献率 = (1 - C) * (1 - W) - A_cpa - 支付手续费
 *   F_total = 总固定成本（采购+头程+包装+国际运费+CPC+退货）
 * 
 * 难点：M 和 F_total 都依赖售价（佣金阶梯、CPA 费）
 * 解决：迭代算法，最多迭代 5 次
 * 
 * 返回：{ priceRMB, commissionRate, error }
 */
export function reversePriceFromMargin(
  targetMarginPercent: number,
  input: CalculationInput,
  commission: CategoryCommission,
  shippingChannel: ShippingChannel | undefined
): { priceRMB: number; commissionRate: number; error?: string } {
  
  const T_m = targetMarginPercent / 100;
  const variableCpcRate =
    input.cpcEnabled && (input.cpcBillingMode || "bidCvr") === "salesPercent"
      ? Math.max(0, input.cpcSalesPercent || 0) / 100
      : 0;
  
  // 1. 计算不依赖售价的固定成本部分
  const purchaseCost = input.purchaseCost;
  const domesticShipping = input.domesticShipping;
  const packagingFee = input.packagingFee;
  
  // 体积重（使用渠道的除数和计费类型）
  const { chargeable: chargeableWeight } = getChargeableWeight(input.length, input.width, input.height, input.weight, shippingChannel);
  const baseShippingCost = shippingChannel ? calculateShippingCost(shippingChannel, chargeableWeight) : 0;
  
  // 退货成本（需要国际运费）
  const calcReturnCost = (internationalShipping: number) => {
    return calculateReturnCost(input.returnHandling, input.returnRate, purchaseCost, domesticShipping, internationalShipping);
  };
  
  // 2. 迭代算法
  let currentPriceRMB = input.targetPriceRMB || 100; // 初始猜测
  let lastPriceRMB = 0;
  let iteration = 0;
  const MAX_ITERATIONS = 5;
  
  while (iteration < MAX_ITERATIONS && Math.abs(currentPriceRMB - lastPriceRMB) > 0.01) {
    lastPriceRMB = currentPriceRMB;
    
    // 用当前售价计算 P_rub 和佣金率
    const priceRUB = cnyToRub(currentPriceRMB, input.exchangeRate);
    const commissionRate = getCommissionRate(commission, priceRUB, input.fulfillmentMode || "RFBS");
    
    // 计算边际贡献率 M
    const cpaRateForM = input.cpaEnabled ? input.cpaRate : 0;
    const M = calculateMarginalContribution(commissionRate, input.withdrawalFee, cpaRateForM, input.paymentFee);
    
    // 熔断检测：销售额比例 CPC 会占用利润率空间，必须进入反推分母。
    const denominator = M - T_m - variableCpcRate;
    if (denominator <= 0) {
      return {
        priceRMB: 0,
        commissionRate,
        error: `目标利润率过高！当前佣金${commissionRate}%、广告率${cpaRateForM}%、CPC销售额占比${(variableCpcRate * 100).toFixed(1)}%、提现手续费${input.withdrawalFee}%、支付手续费${input.paymentFee || 0}%已占据过多空间，最大可实现利润率为 ${((M - variableCpcRate) * 100).toFixed(1)}%`
      };
    }
    
    // 计算国际运费
    const internationalShipping = shippingChannel ? calculateShippingCost(shippingChannel, chargeableWeight) : 0;
    
    // 计算退货成本
    const returnCost = calcReturnCost(internationalShipping);
    
    // 固定 CPC 进入固定成本；销售额比例 CPC 已进入分母，避免反推价偏低。
    const cpcCost = variableCpcRate > 0 ? 0 : calculateInputCpcCost(input, currentPriceRMB);
    
    // 计算总固定成本 F_total
    const F_total = purchaseCost + domesticShipping + packagingFee + internationalShipping + cpcCost + returnCost;
    
    // 逆向公式：P_rmb = F_total / (M - T_m - CPC销售额占比)
    currentPriceRMB = F_total / denominator;
    
    // 边界保护
    if (!isFinite(currentPriceRMB) || currentPriceRMB < 0) {
      return {
        priceRMB: 0,
        commissionRate,
        error: "计算异常：无法推演出合法售价"
      };
    }
    
    iteration++;
  }
  
  // 3. 最终验证：新售价对应的佣金阶梯是否匹配
  const finalPriceRUB = cnyToRub(currentPriceRMB, input.exchangeRate);
  const finalCommissionRate = getCommissionRate(commission, finalPriceRUB, input.fulfillmentMode || "RFBS");
  
  // 验证是否跨阶梯（如果跨阶梯，需要再迭代一次）
  const validation = validatePriceForTier(currentPriceRMB, input.exchangeRate, commission, input.fulfillmentMode || "RFBS");
  if (!validation.valid) {
    // 跨阶梯了，再迭代一轮
    const M = calculateMarginalContribution(finalCommissionRate, input.withdrawalFee, input.cpaEnabled ? input.cpaRate : 0, input.paymentFee);
    const denominator = M - T_m - variableCpcRate;
    if (denominator <= 0) {
      return {
        priceRMB: 0,
        commissionRate: finalCommissionRate,
        error: `目标利润率过高！最大可实现利润率为 ${((M - variableCpcRate) * 100).toFixed(1)}%`
      };
    }
    
    const internationalShipping = shippingChannel ? calculateShippingCost(shippingChannel, chargeableWeight) : 0;
    const returnCost = calcReturnCost(internationalShipping);
    const cpcCost = variableCpcRate > 0 ? 0 : calculateInputCpcCost(input, currentPriceRMB);
    const F_total = purchaseCost + domesticShipping + packagingFee + internationalShipping + cpcCost + returnCost;
    currentPriceRMB = F_total / denominator;
  }
  
  return {
    priceRMB: Math.ceil((currentPriceRMB - Number.EPSILON) * 100) / 100,
    commissionRate: finalCommissionRate,
    error: undefined
  };
}

/**
 * 验证逆向售价是否合法（落在对应佣金阶梯区间）
 * 使用 P_rub = P_rmb × E 去匹配阶梯
 */
export function validatePriceForTier(
  priceRMB: number,
  exchangeRate: number,
  commission: CategoryCommission,
  fulfillmentMode: FulfillmentMode = "RFBS"
): { valid: boolean; tier: number; rate: number; priceRUB: number } {
  const priceRUB = cnyToRub(priceRMB, exchangeRate);
  const tiers = getCommissionTiersForMode(commission, fulfillmentMode);
  const matchedTier = getCommissionTierForPrice(commission, priceRUB, fulfillmentMode);
  const tierIndex = tiers.indexOf(matchedTier);
  return { valid: tierIndex >= 0, tier: tierIndex, rate: matchedTier.rate, priceRUB: normalizeCommissionPriceRUB(priceRUB) };
}

/**
 * 六档定价推荐矩阵（固定锚点）- 迭代算法版本
 * 使用迭代法解决佣金阶梯与售价的循环依赖问题
 * 
 * 六个固定锚点：
 * - 引流价 (-5%): 用于破零，亏损引流
 * - 保本价 (0%): 绝对底线
 * - 起量价 (8%): 追求销量
 * - 常规价 (18%): 日常运营
 * - 高毛利 (30%): 核心盈利
 * - 极限价 (45%): 测试溢价空间
 * 
 * 标准公式：P_target = (采购 + 头程 + 包装 + 跨境运费 + 退货损耗 + CPC成本) / ((1 - 佣金%) × (1 - 提现手续费%) - CPA广告% - 目标利润%)
 */
export function calculateSixTierPricing(
  input: CalculationInput,
  commission: CategoryCommission,
  shippingChannel: ShippingChannel | undefined
): Array<{
  label: string;
  profitMargin: number;
  priceRMB: number;
  priceRUB: number;
  description: string;
  color: string;
  disabled: boolean;
  error?: string;
}> {
  // 六个固定利润率锚点
  const anchors = [
    { label: "引流价", profitMargin: -5, description: "仅用于破零", color: "red" },
    { label: "保本价", profitMargin: 0, description: "绝对底线", color: "orange" },
    { label: "起量价", profitMargin: 8, description: "追求销量", color: "amber" },
    { label: "常规价", profitMargin: 18, description: "日常运营", color: "green" },
    { label: "高毛利", profitMargin: 30, description: "核心盈利", color: "blue" },
    { label: "极限价", profitMargin: 45, description: "测试溢价", color: "purple" },
  ];

  // 🔹 计算固定成本
  const purchaseCost = input.purchaseCost;
  const domesticShipping = input.domesticShipping;
  const packagingFee = input.packagingFee;
  
  // 体积重（使用渠道的除数和计费类型）
  const { chargeable } = getChargeableWeight(input.length, input.width, input.height, input.weight, shippingChannel);
  const internationalShipping = shippingChannel ? calculateShippingCost(shippingChannel, chargeable) : 0;
  
  // 退货成本
  const returnCost = calculateReturnCost(input.returnHandling, input.returnRate, purchaseCost, domesticShipping, internationalShipping);
  
  // 🔹 固定成本基底：销售额比例 CPC 会随每个试算售价变化，因此在迭代内补入。
  const baseFixedCost = purchaseCost + domesticShipping + packagingFee + internationalShipping + returnCost;
  
  // 🔹 安全校验：汇率和固定成本
  const exchangeRate = parseFiniteNumber(input.exchangeRate, 12);
  const fixedCost = parseFiniteNumber(baseFixedCost, 0);
  const withdrawalFee = parseFiniteNumber(input.withdrawalFee, 1.5);
  const paymentFee = parseFiniteNumber(input.paymentFee, 0);
  const cpaRate = input.cpaEnabled ? parseFiniteNumber(input.cpaRate, 0) : 0;

  return anchors.map((anchor) => {
    const T_m = anchor.profitMargin / 100; // 转换为小数
    
    // 🔹 使用迭代算法求解
    let currentPriceRMB = 100; // 初始猜测值
    let lastPriceRMB = 0;
    let iteration = 0;
    const MAX_ITERATIONS = 10;
    let finalCommissionRate = 0;
    let finalM = 0;
    let converged = false;
    
    while (iteration < MAX_ITERATIONS && !converged) {
      lastPriceRMB = currentPriceRMB;
      
      // 1. 根据当前售价计算 P_rub
      const priceRUB = cnyToRub(currentPriceRMB, exchangeRate);
      
      // 2. 🔹 根据 P_rub 匹配佣金率（核心修复点）
      const commissionRate = getCommissionRate(commission, priceRUB, input.fulfillmentMode || "RFBS");
      finalCommissionRate = commissionRate;
      
      // 3. 计算边际贡献率 M
      const M = calculateMarginalContribution(commissionRate, withdrawalFee, cpaRate, paymentFee);
      finalM = M;
      
      // 4. 检查分母
      const denominator = M - T_m;
      
      if (denominator <= 0) {
        break;
      }
      
      // 5. 逆向公式计算新的售价
      const cpcCost = calculateInputCpcCost(input, currentPriceRMB);
      const newPriceRMB = (fixedCost + cpcCost) / denominator;
      
      // 🔹 安全校验：检查计算结果是否合法
      if (!isFinite(newPriceRMB) || isNaN(newPriceRMB) || newPriceRMB <= 0) {
        break;
      }
      
      currentPriceRMB = newPriceRMB;
      
      // 检查是否收敛
      if (Math.abs(currentPriceRMB - lastPriceRMB) < 0.01) {
        converged = true;
      }
      
      iteration++;
    }
    
    // 🔹 计算最终卢布价格（确保数值合法）
    let finalPriceRUB = 0;
    let finalPriceRMB = 0;
    
    if (converged && isFinite(currentPriceRMB) && currentPriceRMB > 0) {
      finalPriceRMB = parseFloat(currentPriceRMB.toFixed(2));
      finalPriceRUB = parseFloat(cnyToRub(finalPriceRMB, exchangeRate).toFixed(0));
      
      // 🔹 再次验证佣金匹配
      const verifyCommission = getCommissionRate(commission, finalPriceRUB, input.fulfillmentMode || "RFBS");
    }
    
    // 🔹 判断是否合法
    const disabled = !converged || finalPriceRMB <= 0 || finalM <= T_m || isNaN(finalPriceRUB) || finalPriceRUB === 0;
    let error: string | undefined;
    
    if (disabled) {
      if (finalM <= T_m && finalM > 0) {
        error = `目标利润率过高！最大可实现 ${(finalM * 100).toFixed(1)}%`;
      } else if (!converged) {
        error = "计算未收敛";
      } else if (finalPriceRMB <= 0) {
        error = "计算结果非正数";
      } else {
        error = "空间不足";
      }
    }

    return {
      label: anchor.label,
      profitMargin: anchor.profitMargin,
      priceRMB: finalPriceRMB,
      priceRUB: finalPriceRUB,
      description: anchor.description,
      color: anchor.color,
      disabled,
      error: disabled ? error : undefined,
    };
  });
}

/**
 * 阶梯定价策略推演 (RMB主导模式)
 * 对每个阶梯佣金率分别代入逆向公式：
 *   P_rmb = (F_total + T) / M
 *   P_rub = P_rmb × E
 * 若 P_rub 落回提取该佣金C时的阶梯区间，则为合法解
 * 返回的售价全部为 RMB
 */
export function calculatePricingStrategies(
  commission: CategoryCommission,
  exchangeRate: number,
  withdrawalFee: number,
  cpaRate: number,
  totalFixedCost: number,
  paymentFee: number = 0,
  cpcSalesPercent: number = 0,
  fulfillmentMode: FulfillmentMode = "RFBS"
): {
  breakEven: number;
  lowProfit: number;
  mediumProfit: number;
  highProfit: number;
} {
  const strategies = {
    breakEven: 0,
    lowProfit: 0,
    mediumProfit: 0,
    highProfit: 0,
  };

  const targetMargins = [0, 0.1, 0.2, 0.3];

  const labels = ["breakEven", "lowProfit", "mediumProfit", "highProfit"] as const;

  for (let i = 0; i < targetMargins.length; i++) {
    const targetMargin = targetMargins[i];
    let validPriceRMB = Infinity;

    for (const tier of getCommissionTiersForMode(commission, fulfillmentMode)) {
      const M = calculateMarginalContribution(tier.rate, withdrawalFee, cpaRate, paymentFee) - (cpcSalesPercent / 100);
      const denominator = M - targetMargin;
      if (denominator <= 0) continue;

      // 按销售利润率反推售价：P_rmb * M - F = P_rmb * 目标利润率。
      const P_rmb = totalFixedCost / denominator;
      // 转换为 P_rub 验证是否在当前阶梯区间
      const matchedTier = getCommissionTierForPrice(commission, cnyToRub(P_rmb, exchangeRate), fulfillmentMode);

      if (matchedTier === tier) {
        validPriceRMB = Math.min(validPriceRMB, P_rmb);
      }
    }

    strategies[labels[i]] = validPriceRMB === Infinity ? 0 : Math.ceil(validPriceRMB * 100) / 100;
  }

  return strategies;
}

/**
 * 黑洞预警检测 (RMB主导模式)
 * 检测当前售价是否处于阶梯佣金跃升边缘
 */
export function detectCommissionBlackHole(
  priceRMB: number,
  exchangeRate: number,
  commission: CategoryCommission,
  withdrawalFee: number,
  cpaRate: number,
  totalFixedCost: number,
  cpcCost: number,
  paymentFee: number = 0,
  fulfillmentMode: FulfillmentMode = "RFBS"
): string | null {
  const priceRUB = cnyToRub(priceRMB, exchangeRate);
  const currentRate = getCommissionRate(commission, priceRUB, fulfillmentMode);

  for (const tier of getCommissionTiersForMode(commission, fulfillmentMode)) {
    if (tier.rate < currentRate) {
      // 将售价降到该阶梯的最大值（RUB），再转回 RMB
      const lowerPriceRUB = normalizeTierMax(tier);
      if (!Number.isFinite(lowerPriceRUB)) continue;
      const lowerPriceRMB = rubToCny(lowerPriceRUB, exchangeRate);
      const M_lower = calculateMarginalContribution(tier.rate, withdrawalFee, cpaRate, paymentFee);
      const M_current = calculateMarginalContribution(currentRate, withdrawalFee, cpaRate, paymentFee);

      if (M_lower > 0 && M_current > 0) {
        const profitLower = calculateNetProfit(lowerPriceRMB, M_lower, totalFixedCost);
        const profitCurrent = calculateNetProfit(priceRMB, M_current, totalFixedCost);

        if (profitLower > profitCurrent && profitLower > 0) {
          const diff = profitLower - profitCurrent;
          return `若降价至 ${lowerPriceRUB} ₽ (¥${lowerPriceRMB.toFixed(2)}) 触发低佣金档，净利润反而提升 ¥${diff.toFixed(2)}！`;
        }
      }
    }
  }
  return null;
}

/**
 * 汇率抗压测试 (RMB主导模式)
 * 
 * 核心逻辑：
 * - 前台卢布售价 (P_rub) 固定不变
 * - exchangeRate 表示 1 CNY = N RUB
 * - 卢布贬值/回款汇率恶化时，exchangeRate 上升，RMB 回款 = P_rub / 新汇率
 * - 压力利润 = 新 RMB 回款 × 边际贡献率 - 固定成本合计
 */
export function calculateExchangeRateStressTest(
  priceRMB: number,
  exchangeRate: number,
  commission: CategoryCommission,
  withdrawalFee: number,
  cpaRate: number,
  totalFixedCost: number,
  paymentFee: number = 0,
  cpcSalesPercent: number = 0,
  fulfillmentMode: FulfillmentMode = "RFBS"
): {
  at5PercentDrop: number;
  at10PercentDrop: number;
  zeroProfitRate: number;
} {
  // 🔹 非空校验：确保参与运算的值均经过 parseFloat()
  const pRMB = parseFiniteNumber(priceRMB, 0);
  const exRate = parseFiniteNumber(exchangeRate, 12);
  const wFee = parseFiniteNumber(withdrawalFee, 1.5);
  const cRate = parseFiniteNumber(cpaRate, 0);
  const pFee = parseFiniteNumber(paymentFee, 0);
  const cpcRate = Math.max(0, parseFiniteNumber(cpcSalesPercent, 0)) / 100;
  const fCost = parseFiniteNumber(totalFixedCost, 0);
  
  // 🔹 前台卢布售价（固定）
  const priceRUB = cnyToRub(pRMB, exRate);
  
  // 当前佣金率
  const currentCommissionRate = getCommissionRate(commission, priceRUB, fulfillmentMode);
  const currentM = calculateMarginalContribution(currentCommissionRate, wFee, cRate, pFee);

  // 计算回款汇率恶化后的利润
  const calcProfitAtExchangeRate = (newExchangeRate: number) => {
    if (newExchangeRate <= 0) return -Infinity;
    
    // 新的 RMB 售价
    const newPriceRMB = rubToCny(priceRUB, newExchangeRate);
    // 新的卢布售价（理论上不变，但佣金阶梯可能变化）
    const newPriceRUB = cnyToRub(newPriceRMB, newExchangeRate);
    // 获取新的佣金率
    const newCommissionRate = getCommissionRate(commission, newPriceRUB, fulfillmentMode);
    // 计算新的边际贡献率
    const M = calculateMarginalContribution(newCommissionRate, wFee, cRate, pFee);
    
    if (M <= 0) return -Infinity;
    // 🔹 口径：exchangeRate 越高，固定卢布售价折回人民币越少
    return calculateNetProfit(newPriceRMB, M, fCost + newPriceRMB * cpcRate);
  };

  // 回款汇率恶化 5%（1 CNY = N RUB 中的 N 上升 5%）
  const at5PercentDrop = calcProfitAtExchangeRate(exRate * 1.05);
  
  // 回款汇率恶化 10%
  const at10PercentDrop = calcProfitAtExchangeRate(exRate * 1.10);

  // 🔹 0 利润极值汇率：公式 = F_fixed / (P_rub × M)
  let zeroProfitRate = 0;
  
  // 🔹 计算当前利润
  const currentProfit = currentM > 0 ? calculateNetProfit(pRMB, currentM, fCost + pRMB * cpcRate) : -fCost;
  
  if (currentM > 0 && priceRUB > 0 && currentProfit > 0) {
    // 在当前佣金阶梯下的 0 利润汇率
    // 利润 = (P_rub / E) × M - F_total = 0
    // E = P_rub × M / F_total
    zeroProfitRate = fCost > 0 && currentM > cpcRate ? (priceRUB * (currentM - cpcRate)) / fCost : 0;
    
    // 验证该汇率对应的佣金阶梯是否一致
    if (zeroProfitRate > 0) {
      const testPriceRMB = rubToCny(priceRUB, zeroProfitRate);
      const testPriceRUB = cnyToRub(testPriceRMB, zeroProfitRate);
      const testCommissionRate = getCommissionRate(commission, testPriceRUB, fulfillmentMode);
      
      if (testCommissionRate !== currentCommissionRate) {
        // 如果跨阶梯，需要迭代求解
        // 简化处理：使用二分法逼近
        let low = exRate;
        let high = exRate * 2;
        let highProfit = calcProfitAtExchangeRate(high);
        while (isFinite(highProfit) && highProfit > 0 && high < exRate * 8) {
          high *= 1.5;
          highProfit = calcProfitAtExchangeRate(high);
        }
        
        for (let i = 0; i < 20; i++) {
          const mid = (low + high) / 2;
          const profit = calcProfitAtExchangeRate(mid);
          
          if (!isFinite(profit)) {
            break;
          }
          
          if (Math.abs(profit) < 0.01) {
            zeroProfitRate = mid;
            break;
          }
          
          if (profit > 0) {
            low = mid;
          } else {
            high = mid;
          }
        }
      }
    }
  }
  
  // 🔹 逻辑纠偏：如果当前利润为正，绝对禁止显示'已无法保本'（zeroProfitRate必须>0）
  // 只有当分母为 0 时才触发此状态
  if (currentProfit <= 0) {
    zeroProfitRate = 0; // 当前已亏损，无法计算极值
  }

  return { 
    at5PercentDrop: isFinite(at5PercentDrop) ? at5PercentDrop : -Infinity,
    at10PercentDrop: isFinite(at10PercentDrop) ? at10PercentDrop : -Infinity,
    zeroProfitRate: isFinite(zeroProfitRate) && zeroProfitRate > 0 ? zeroProfitRate : 0
  };
}

/**
 * 利润演练：计算一个售价区间内的利润曲线数据 (RMB主导模式)
 * priceRange 为 RMB 售价数组
 */
export function calculateProfitCurve(
  priceRangeRMB: number[],
  exchangeRate: number,
  commission: CategoryCommission,
  withdrawalFee: number,
  cpaRate: number,
  totalFixedCost: number,
  paymentFee: number = 0,
  cpcSalesPercent: number = 0,
  fulfillmentMode: FulfillmentMode = "RFBS"
): { priceRMB: number; priceRUB: number; profit: number; commissionRate: number }[] {
  const cpcRate = Math.max(0, cpcSalesPercent || 0) / 100;
  return priceRangeRMB.map((priceRMB) => {
    const priceRUB = cnyToRub(priceRMB, exchangeRate);
    const rate = getCommissionRate(commission, priceRUB, fulfillmentMode);
    const M = calculateMarginalContribution(rate, withdrawalFee, cpaRate, paymentFee);
    const dynamicCpcCost = priceRMB * cpcRate;
    const profit = M > 0 ? calculateNetProfit(priceRMB, M, totalFixedCost + dynamicCpcCost) : -(totalFixedCost + dynamicCpcCost);
    return { priceRMB, priceRUB, profit, commissionRate: rate };
  });
}

/**
 * 计算多件装分摊运费利润 (RMB主导模式)
 */
export function calculateMultiItemProfit(
  itemCount: number,
  input: CalculationInput,
  shippingChannel: ShippingChannel,
  commission: CategoryCommission
): { profitPerItem: number; totalProfit: number; profitMargin: number } {
  const normalizedItemCount = Math.max(1, Math.floor(Number.isFinite(itemCount) ? itemCount : 1));
  const chargeableWeight = getChargeableWeight(input.length, input.width, input.height, input.weight, shippingChannel).chargeable;
  const totalWeight = chargeableWeight * normalizedItemCount;
  const totalShippingCost = calculateShippingCost(shippingChannel, totalWeight);
  const shippingPerItem = totalShippingCost / normalizedItemCount;

  const returnCost = calculateReturnCost(
    input.returnHandling,
    input.returnRate,
    input.purchaseCost,
    input.domesticShipping,
    shippingPerItem
  );

  const cpcCost = calculateInputCpcCost(input, input.targetPriceRMB);
  const cpaCost = calculateCpaCost(input.cpaEnabled, input.cpaRate, input.targetPriceRMB);

  const totalFixedCost = input.purchaseCost + input.domesticShipping + input.packagingFee + shippingPerItem + cpcCost + returnCost;

  const priceRUB = cnyToRub(input.targetPriceRMB, input.exchangeRate);
  const commissionRate = getCommissionRate(commission, priceRUB, input.fulfillmentMode || "RFBS");
  const M = calculateMarginalContribution(commissionRate, input.withdrawalFee, input.cpaEnabled ? input.cpaRate : 0, input.paymentFee);

  if (M <= 0) {
    return { profitPerItem: -Infinity, totalProfit: -Infinity, profitMargin: -Infinity };
  }

  const profitPerItem = calculateNetProfit(input.targetPriceRMB, M, totalFixedCost);
  const totalProfit = profitPerItem * normalizedItemCount;
  const revenue = input.targetPriceRMB * normalizedItemCount;
  const profitMargin = revenue > 0 ? (totalProfit / revenue) * 100 : 0;

  return { profitPerItem, totalProfit, profitMargin };
}

/**
 * 划线原价推导 (RMB主导模式)
 * 划线原价 = 推演售价 P_rmb / (1 - 大促折扣率)
 */
export function calculateOriginalPrice(
  sellingPriceRMB: number,
  promotionDiscount: number
): number {
  const discount = normalizePromotionDiscount(promotionDiscount);
  return sellingPriceRMB / (1 - discount / 100);
}

export function normalizePromotionDiscount(promotionDiscount: number): number {
  return normalizePercent(promotionDiscount, 99);
}

/**
 * ROAS 计算 (RMB主导模式)
 * ROAS = 收入(RMB) / 广告支出(RMB)
 */
export function calculateROAS(
  priceRMB: number,
  totalAdCost: number
): number {
  if (totalAdCost <= 0) return Infinity;
  return priceRMB / totalAdCost;
}

/**
 * 盈亏平衡 ROAS 底线
 */
export function calculateBreakEvenROAS(
  totalCost: number,
  totalAdCost: number
): number {
  if (totalAdCost <= 0) return 0;
  return totalCost / totalAdCost;
}

/**
 * 计算保本 ACOS (Advertising Cost of Sales)
 * 公式：保本 ACOS = 毛利(扣除广告前) / 销售额
 * 
 * 毛利(扣除广告前) = P_rmb × (1 - C%) × (1 - W%) - F_total_without_ads
 * 其中 F_total_without_ads 不包含广告费
 * 
 * CPA 模式：CPA 费用已经包含在边际贡献率 M 中，需要重新计算
 * CPC 模式：CPC 费用在固定成本中，需要扣除
 */
export function calculateBreakEvenACOS(
  priceRMB: number,
  commissionRate: number,
  withdrawalFee: number,
  cpaEnabled: boolean,
  cpaRate: number,
  totalFixedCostWithoutAds: number,
  paymentFee: number = 0
): number {
  if (priceRMB <= 0) return 0;
  
  // 计算不包含 CPA 的边际贡献率
  const M = calculateMarginalContribution(commissionRate, withdrawalFee, 0, paymentFee);
  
  // 毛利(扣除广告前) = P_rmb × M - F_total_without_ads
  const grossProfitBeforeAds = priceRMB * M - totalFixedCostWithoutAds;
  
  // 保本 ACOS = 毛利(扣除广告前) / 销售额
  const breakEvenACOS = (grossProfitBeforeAds / priceRMB) * 100;
  
  return Math.max(0, breakEvenACOS);
}

/**
 * CVR 灵敏度分析
 * 计算 CVR 提升 1% 对成本和利润的影响
 * 
 * 返回：{
 *   costReduction: 单均转化成本下降金额 (RMB),
 *   profitIncreasePercent: 净利润提升百分比
 * }
 */
export function calculateCVRsensitivity(
  currentCVR: number, // 当前转化率 (%)
  cpcBid: number, // 单次竞价 (RUB)
  exchangeRate: number, // RUB/CNY
  currentProfit: number, // 当前净利润 (RMB)
  priceRMB: number // 售价 (RMB)
): {
  costReduction: number;
  profitIncreasePercent: number;
  newCost: number;
  currentCost: number;
} {
  if (currentCVR <= 0 || currentCVR >= 100) {
    return {
      costReduction: 0,
      profitIncreasePercent: 0,
      newCost: 0,
      currentCost: 0
    };
  }
  
  // 当前单均转化成本
  const currentCost = rubToCny(cpcBid / (currentCVR / 100), exchangeRate);
  
  // CVR 提升 1% 后的成本
  const newCVR = currentCVR + 1;
  const newCost = rubToCny(cpcBid / (newCVR / 100), exchangeRate);
  
  // 成本下降
  const costReduction = currentCost - newCost;
  
  // 净利润提升百分比
  const newProfit = currentProfit + costReduction;
  const profitIncreasePercent = currentProfit > 0 
    ? ((newProfit - currentProfit) / Math.abs(currentProfit)) * 100 
    : 0;
  
  return {
    costReduction,
    profitIncreasePercent,
    newCost,
    currentCost
  };
}

/**
 * 税务沙盘：默认不改变系统原有净利润口径，只在开启时给出税后视图。
 *
 * 这里采用保守估算：
 * - 销项税 = 售价 × 增值税率
 * - 可抵扣进项税 = 采购/头程/包装 × 增值税率
 * - 企业所得税按扣除增值税后的正利润估算
 */
export function calculateTaxSimulation(
  input: CalculationInput,
  preTaxNetProfit: number
): CalculationResult["taxes"] {
  const enabled = input.taxEnabled === true;
  const normalizedVatRate = normalizePercent(input.vatRate || 0);
  const normalizedCorporateTaxRate = normalizePercent(input.corporateTaxRate || 0);
  const vatRate = normalizedVatRate / 100;
  const corporateTaxRate = normalizedCorporateTaxRate / 100;

  if (!enabled) {
    return {
      enabled: false,
      vatRate: normalizedVatRate,
      corporateTaxRate: normalizedCorporateTaxRate,
      outputVat: 0,
      inputVatCredit: 0,
      vatPayable: 0,
      corporateTax: 0,
      preTaxNetProfit,
      afterTaxNetProfit: preTaxNetProfit,
      afterTaxProfitMargin: input.targetPriceRMB > 0 ? (preTaxNetProfit / input.targetPriceRMB) * 100 : 0,
    };
  }

  const outputVat = input.targetPriceRMB * vatRate;
  const inputVatCredit = (input.purchaseCost + input.domesticShipping + input.packagingFee) * vatRate;
  const vatPayable = Math.max(0, outputVat - inputVatCredit);
  const taxableProfit = Math.max(0, preTaxNetProfit - vatPayable);
  const corporateTax = taxableProfit * corporateTaxRate;
  const afterTaxNetProfit = preTaxNetProfit - vatPayable - corporateTax;

  return {
    enabled,
    vatRate: normalizedVatRate,
    corporateTaxRate: normalizedCorporateTaxRate,
    outputVat,
    inputVatCredit,
    vatPayable,
    corporateTax,
    preTaxNetProfit,
    afterTaxNetProfit,
    afterTaxProfitMargin: input.targetPriceRMB > 0 ? (afterTaxNetProfit / input.targetPriceRMB) * 100 : 0,
  };
}

/**
 * 佣金跳档感应
 * 检测当前售价是否处于佣金阶梯跳档点的 ±2% 范围内
 * 
 * 返回：优化建议或 null
 */
export function detectCommissionTierBoundary(
  priceRUB: number,
  exchangeRate: number,
  commission: CategoryCommission,
  withdrawalFee: number,
  cpaRate: number,
  totalFixedCost: number,
  paymentFee: number = 0,
  fulfillmentMode: FulfillmentMode = "RFBS"
): { 
  isNearBoundary: boolean; 
  suggestion?: string;
  lowerPriceRUB?: number;
  lowerPriceRMB?: number;
  profitIncrease?: number;
} {
  const normalizedPriceRUB = normalizeCommissionPriceRUB(priceRUB);
  const tiers = getCommissionTiersForMode(commission, fulfillmentMode);
  const boundaries = tiers
    .map((tier) => normalizeTierMax(tier))
    .filter((max): max is number => Number.isFinite(max))
    .sort((a, b) => a - b);
  
  for (const boundary of boundaries) {
    // 计算 ±2% 范围
    const lowerBound = boundary * 0.98;
    const upperBound = boundary * 1.02;
    
    // 检测是否在边界附近
    if (normalizedPriceRUB >= lowerBound && normalizedPriceRUB <= upperBound) {
      // 当前售价在边界附近，计算降价到边界以下的利润
      const targetPriceRUB = boundary - 1; // 降到边界以下 1 RUB
      const targetPriceRMB = rubToCny(targetPriceRUB, exchangeRate);
      
      // 计算降价后的佣金率
      const lowerCommissionRate = getCommissionRate(commission, targetPriceRUB, fulfillmentMode);
      const currentCommissionRate = getCommissionRate(commission, normalizedPriceRUB, fulfillmentMode);
      
      // 如果降价后佣金率更低
      if (lowerCommissionRate < currentCommissionRate) {
        const M_lower = calculateMarginalContribution(lowerCommissionRate, withdrawalFee, cpaRate, paymentFee);
        const M_current = calculateMarginalContribution(currentCommissionRate, withdrawalFee, cpaRate, paymentFee);
        
        if (M_lower > 0 && M_current > 0) {
          const profitLower = calculateNetProfit(targetPriceRMB, M_lower, totalFixedCost);
          const currentPriceRMB = rubToCny(normalizedPriceRUB, exchangeRate);
          const profitCurrent = calculateNetProfit(currentPriceRMB, M_current, totalFixedCost);
          
          if (profitLower > profitCurrent) {
            return {
              isNearBoundary: true,
              suggestion: `💡 优化建议：微调售价至 ${targetPriceRUB.toFixed(0)} ₽ 可降低佣金比例至 ${lowerCommissionRate}%，利润反而增加 ¥${(profitLower - profitCurrent).toFixed(2)}`,
              lowerPriceRUB: targetPriceRUB,
              lowerPriceRMB: targetPriceRMB,
              profitIncrease: profitLower - profitCurrent
            };
          }
        }
      }
    }
  }
  
  return { isNearBoundary: false };
}

/**
 * 物流阶梯优化建议
 * 检测包裹是否接近下一运费阶梯
 * 
 * 返回：优化建议或 null
 */
export function detectShippingWeightBoundary(
  currentChargeableWeight: number,
  shippingChannel: ShippingChannel | undefined
): {
  isNearBoundary: boolean;
  suggestion?: string;
  weightToReduce?: number;
  costSaving?: number;
} {
  if (!shippingChannel) {
    return { isNearBoundary: false };
  }
  
  // 检测是否距离更轻档位不足 10% 或 50g
  const threshold = Math.min(currentChargeableWeight * 0.1, 50);
  
  // 这里简化处理：假设每减少 50g 可以节省一定费用
  // 实际应该查询物流表的阶梯定价
  const weightToReduce = currentChargeableWeight % 50;
  
  if (weightToReduce > 0 && weightToReduce <= threshold) {
    // 计算节省的费用（简化计算）
    const costPerGram = (shippingChannel.pricePerKg || 65) / 1000;
    const costSaving = weightToReduce * costPerGram;
    
    if (costSaving > 0.5) { // 只有节省超过 0.5 元才提示
      return {
        isNearBoundary: true,
        suggestion: `⚠️ 边际提醒：包裹减重 ${weightToReduce.toFixed(0)}g 即可进入下一运费阶梯，每单节省 ¥${costSaving.toFixed(2)}`,
        weightToReduce,
        costSaving
      };
    }
  }
  
  return { isNearBoundary: false };
}

/**
 * 物流拦截极限检测
 * 检测包裹尺寸是否接近物流渠道的限制
 * 
 * 返回：警告信息数组
 */
export function detectShippingDimensionLimits(
  length: number,
  width: number,
  height: number,
  shippingChannel: ShippingChannel | undefined
): Array<{
  type: 'length' | 'width' | 'height' | 'sum' | 'longEdge';
  current: number;
  limit: number;
  warning: string;
}> {
  const warnings: Array<{
    type: 'length' | 'width' | 'height' | 'sum' | 'longEdge';
    current: number;
    limit: number;
    warning: string;
  }> = [];
  
  if (!shippingChannel) return warnings;
  
  // 包裹可以旋转，尺寸预警必须和物流拦截一样按三边排序后比较。
  const productDims = [length, width, height].filter((value) => value > 0).sort((a, b) => b - a);
  const channelDims = [
    normalizeShippingLimit(shippingChannel.maxLength),
    normalizeShippingLimit(shippingChannel.maxWidth),
    normalizeShippingLimit(shippingChannel.maxHeight),
  ];

  if (productDims.length === 3 && channelDims.every((limit) => limit !== undefined)) {
    const sortedChannelDims = (channelDims as number[]).sort((a, b) => b - a);
    const checks = [
      { label: "长边", current: productDims[0], limit: sortedChannelDims[0] },
      { label: "中间边", current: productDims[1], limit: sortedChannelDims[1] },
      { label: "短边", current: productDims[2], limit: sortedChannelDims[2] },
    ];

    const exceeded = checks.find((check) => check.current > check.limit);
    if (exceeded) {
      warnings.push({
        type: 'longEdge',
        current: exceeded.current,
        limit: exceeded.limit,
        warning: `🚫 ${exceeded.label}超出物流限制！当前 ${exceeded.current} cm，最大 ${exceeded.limit} cm`
      });
    } else {
      const nearLimit = checks.find((check) => check.current >= check.limit * 0.95);
      if (nearLimit) {
        warnings.push({
          type: 'longEdge',
          current: nearLimit.current,
          limit: nearLimit.limit,
          warning: `⚠️ ${nearLimit.label}接近物流限制 (${nearLimit.current}/${nearLimit.limit} cm)`
        });
      }
    }
  } else {
    const longEdge = productDims[0] || 0;
    const maxLongEdge = Math.max(...channelDims.filter((limit): limit is number => limit !== undefined));
    if (Number.isFinite(maxLongEdge) && maxLongEdge > 0 && longEdge > 0 && longEdge >= maxLongEdge * 0.95 && longEdge <= maxLongEdge) {
      warnings.push({
        type: 'longEdge',
        current: longEdge,
        limit: maxLongEdge,
        warning: `⚠️ 长边接近物流限制 (${longEdge}/${maxLongEdge} cm)`
      });
    }
    if (Number.isFinite(maxLongEdge) && maxLongEdge > 0 && longEdge > maxLongEdge) {
      warnings.push({
        type: 'longEdge',
        current: longEdge,
        limit: maxLongEdge,
        warning: `🚫 长边超出物流限制！当前 ${longEdge} cm，最大 ${maxLongEdge} cm`
      });
    }
  }
  
  // 检测边长总和
  const sumDimension = length + width + height;
  const maxSumDimension = normalizeShippingLimit(shippingChannel.maxSumDimension);
  if (maxSumDimension !== undefined && sumDimension > 0) {
    if (sumDimension >= maxSumDimension * 0.95 && sumDimension <= maxSumDimension) {
      warnings.push({
        type: 'sum',
        current: sumDimension,
        limit: maxSumDimension,
        warning: `⚠️ 边长总和接近限制 (${sumDimension}/${maxSumDimension} cm)`
      });
    }
    if (sumDimension > maxSumDimension) {
      warnings.push({
        type: 'sum',
        current: sumDimension,
        limit: maxSumDimension,
        warning: `🚫 边长总和超出限制！当前 ${sumDimension} cm，最大 ${maxSumDimension} cm`
      });
    }
  }
  
  return warnings;
}

/**
 * 主计算函数：综合所有输入，输出完整计算结果 (RMB主导模式)
 */
export function performFullCalculation(
  input: CalculationInput,
  commission: CategoryCommission | undefined,
  shippingChannel: ShippingChannel | undefined
): CalculationResult {
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // 体积重计算（使用渠道的除数和计费类型）
  const { volumetric: volumetricWeight, chargeable: chargeableWeight, isVolumetric } =
    getChargeableWeight(input.length, input.width, input.height, input.weight, shippingChannel);

  if (isVolumetric) {
    warnings.push(`泡货预警：当前将按体积重 (${chargeableWeight.toFixed(0)} g) 计费，建议优化包装尺寸。`);
  }
  
  // 物流拦截极限检测
  const dimensionWarnings = detectShippingDimensionLimits(
    input.length,
    input.width,
    input.height,
    shippingChannel
  );
  dimensionWarnings.forEach(dw => warnings.push(dw.warning));

  // 默认佣金
  const defaultCommission: CategoryCommission = {
    primaryCategory: input.primaryCategory,
    secondaryCategory: input.secondaryCategory,
    tiers: [
      { min: 0, max: 1500, rate: 12 },
      { min: 1500.01, max: 5000, rate: 15 },
      { min: 5000.01, max: Infinity, rate: 18 },
    ],
  };
  const activeCommission = commission || defaultCommission;

  // ===== 核心变更：用 P_rmb 算出 P_rub，再用 P_rub 匹配佣金 =====
  const priceRMB = input.targetPriceRMB;
  const priceRUB = cnyToRub(priceRMB, input.exchangeRate);
  
  const fulfillmentMode = input.fulfillmentMode || "RFBS";
  const commissionRate = getCommissionRate(activeCommission, priceRUB, fulfillmentMode);
  
  // 物流费
  const internationalShipping = shippingChannel
    ? calculateShippingCost(shippingChannel, chargeableWeight)
    : 0;

  // 广告费 (RMB)
  const cpcCost = calculateInputCpcCost(input, priceRMB);
  const cpaCost = calculateCpaCost(input.cpaEnabled, input.cpaRate, priceRMB);
  const totalAdCost = cpcCost + cpaCost;
  const variableCpcSalesPercent =
    input.cpcEnabled && (input.cpcBillingMode || "bidCvr") === "salesPercent"
      ? input.cpcSalesPercent || 0
      : 0;

  // 退货成本 (RMB)
  const returnCost = calculateReturnCost(
    input.returnHandling,
    input.returnRate,
    input.purchaseCost,
    input.domesticShipping,
    internationalShipping
  );

  // 总固定成本 F_total (RMB)
  const totalFixedCost =
    input.purchaseCost +
    input.domesticShipping +
    input.packagingFee +
    internationalShipping +
    cpcCost +
    returnCost;

  // 有效边际贡献率 M
  const cpaRateForM = input.cpaEnabled ? input.cpaRate : 0;
  const M = calculateMarginalContribution(commissionRate, input.withdrawalFee, cpaRateForM, input.paymentFee);

  // 熔断检测
  if (M <= 0) {
    warnings.push("严重警告：平台抽成、广告率与手续费之和已超 100%，无论如何定价皆亏损！");
  }

  // ===== 正向算利润：净利润(RMB) = P_rmb × M - F_total =====
  const netProfit = M > 0 ? calculateNetProfit(priceRMB, M, totalFixedCost) : -totalFixedCost;

  // 平台抽成金额 (RMB) = P_rmb × C%
  const commissionAmount = priceRMB * (commissionRate / 100);

  // 提现手续费金额 (RMB) = P_rmb × (1-C%) × W%
  const withdrawalFeeAmount = priceRMB * (1 - commissionRate / 100) * (input.withdrawalFee / 100);
  const paymentFeeAmount = priceRMB * ((input.paymentFee || 0) / 100);

  // ROI（投资回报率）= 净利润 ÷ 总成本 × 100%
  // 总成本包含所有实际支出（采购+头程+包装+跨境运费+佣金+提现手续费+支付手续费+广告+退货损耗）
  const totalCost = totalFixedCost + commissionAmount + withdrawalFeeAmount + paymentFeeAmount + cpaCost;
  const roi = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;

  // 销售利润率 = 净利润 / 收入(P_rmb)
  const profitMargin = priceRMB > 0 ? (netProfit / priceRMB) * 100 : 0;

  // 定价策略 (返回 RMB)
  const pricingStrategies = calculatePricingStrategies(
    activeCommission,
    input.exchangeRate,
    input.withdrawalFee,
    cpaRateForM,
    totalFixedCost - (variableCpcSalesPercent > 0 ? cpcCost : 0),
    input.paymentFee,
    variableCpcSalesPercent,
    fulfillmentMode
  );

  // 黑洞预警
  const blackHoleWarning = detectCommissionBlackHole(
    priceRMB,
    input.exchangeRate,
    activeCommission,
    input.withdrawalFee,
    cpaRateForM,
    totalFixedCost,
    cpcCost,
    input.paymentFee,
    fulfillmentMode
  );
  if (blackHoleWarning) {
    suggestions.push(blackHoleWarning);
  }

  // ===== 新增：广告风控计算 =====
  // 计算不包含广告费的固定成本
  const totalFixedCostWithoutAds = 
    input.purchaseCost + 
    input.domesticShipping + 
    input.packagingFee + 
    internationalShipping + 
    returnCost;
  
  // 计算保本 ACOS
  const breakEvenACOS = calculateBreakEvenACOS(
    priceRMB,
    commissionRate,
    input.withdrawalFee,
    input.cpaEnabled,
    input.cpaEnabled ? input.cpaRate : 0,
    totalFixedCostWithoutAds,
    input.paymentFee
  );
  
  // 计算当前 ACOS
  const currentACOS = priceRMB > 0 ? (totalAdCost / priceRMB) * 100 : 0;
  
  // 检测是否超预算：统一按当前 ACOS 是否超过保本 ACOS 判断，避免 CPA 率在 M 中扣除后再次被 totalAdCost 双扣。
  const isOverBudget = currentACOS > breakEvenACOS + 0.0001 && totalAdCost > 0;

  // ROAS 警告与 ACOS 保本线共用同一口径，避免出现 ACOS 未超保本但 ROAS 单独报亏损。
  const roas = calculateROAS(priceRMB, totalAdCost);
  const breakEvenAdCost = priceRMB * (breakEvenACOS / 100);
  const breakEvenROAS = breakEvenAdCost > 0 ? calculateBreakEvenROAS(priceRMB, breakEvenAdCost) : Infinity;
  if (isOverBudget) {
    const breakEvenRoasText = Number.isFinite(breakEvenROAS) ? breakEvenROAS.toFixed(2) : "无保本空间";
    warnings.push(`当前 ACOS (${currentACOS.toFixed(1)}%) 已超过保本 ACOS (${breakEvenACOS.toFixed(1)}%)，ROAS (${roas.toFixed(2)}) 低于保本线 (${breakEvenRoasText})。`);
  }
  
  // CVR 灵敏度分析（仅当 CPC 启用时）
  const cvrSensitivity = input.cpcEnabled && (input.cpcBillingMode || "bidCvr") === "bidCvr" && input.cpcConversionRate > 0
    ? calculateCVRsensitivity(
        input.cpcConversionRate,
        input.cpcBid,
        input.exchangeRate,
        netProfit,
        priceRMB
      )
    : undefined;
  
  // ===== 新增：智能提醒计算 =====
  // 佣金跳档感应
  const commissionTierBoundary = detectCommissionTierBoundary(
    priceRUB,
    input.exchangeRate,
    activeCommission,
    input.withdrawalFee,
    cpaRateForM,
    totalFixedCost,
    input.paymentFee,
    fulfillmentMode
  );
  
  // 物流阶梯优化
  const shippingWeightBoundary = detectShippingWeightBoundary(
    chargeableWeight,
    shippingChannel
  );
  
  // 添加智能提醒到建议列表
  if (commissionTierBoundary.isNearBoundary && commissionTierBoundary.suggestion) {
    suggestions.push(commissionTierBoundary.suggestion);
  }
  if (shippingWeightBoundary.isNearBoundary && shippingWeightBoundary.suggestion) {
    suggestions.push(shippingWeightBoundary.suggestion);
  }

  // 亏损警告
  if (netProfit < 0) {
    warnings.push(`当前定价亏损 ¥${Math.abs(netProfit).toFixed(2)}，请提高售价或降低成本！`);
  }

  const taxes = calculateTaxSimulation(input, netProfit);

  return {
    netProfit,
    roi,
    profitMargin,
    commissionRate,
    costs: {
      purchase: input.purchaseCost,
      domesticShipping: input.domesticShipping,
      packaging: input.packagingFee,
      internationalShipping,
      commission: commissionAmount,
      cpaCost,
      cpcCost,
      returnCost,
      withdrawalFee: withdrawalFeeAmount,
      paymentFee: paymentFeeAmount,
      total: totalFixedCost + commissionAmount + withdrawalFeeAmount + paymentFeeAmount + cpaCost,
    },
    taxes,
    pricingStrategies,
    recommendedShipping: shippingChannel || DEFAULT_SHIPPING_DATA[0],
    shippingAlternatives: [],
    warnings,
    suggestions,
    volumetricWeight,
    chargeableWeight,
    isVolumetric,
    // 广告风控
    adRiskControl: {
      breakEvenACOS,
      currentACOS,
      isOverBudget,
      cvrSensitivity,
    },
    // 智能提醒
    smartAdvisor: {
      commissionTierBoundary,
      shippingWeightBoundary,
    },
  };
}

const DEFAULT_SHIPPING_DATA: ShippingChannel[] = [
  { id: "1", name: "中国邮政挂号小包", thirdParty: "中国邮政", serviceTier: "Small", serviceLevel: "Economy", fixFee: 2, varFeePerGram: 0.063, pricePerKg: 65, pricePerCubic: 0, minWeight: 0, maxWeight: 2000, maxLength: 60, maxWidth: 60, maxHeight: 60, maxSumDimension: 150, deliveryTimeMin: 25, deliveryTimeMax: 35, deliveryTime: 30, maxValueRUB: 30000, maxValue: 2460, billingType: "实际重量", volumetricDivisor: 0, ozonRating: 0, batteryAllowed: false, liquidAllowed: false },
];

/**
 * 智能售价建议：当用户未填写售价且无可用渠道时，
 * 分析哪些渠道仅因货值被拦截，推算最低匹配售价
 * 
 * 分类逻辑：
 * - 仅因货值被拦截 → 可通过调价修复
 * - 有其他原因(尺寸/重量/属性) → 调价无法修复
 */
export interface SuggestedPriceResult {
  suggestedPriceRMB: number;       // 建议最低售价(RMB)
  suggestedPriceRUB: number;       // 建议最低售价(RUB)
  channelName: string;             // 对应渠道名
  fixableChannels: Array<{         // 可修复渠道列表
    channelName: string;
    minValueRUB: number;
    minPriceRMB: number;
    suggestedPriceRMB: number;
    profitPriceRMB?: number;
    logisticsPriceRMB: number;
    reason: "profit-target" | "logistics-threshold";
  }>;
  unfixableChannelCount: number;   // 不可修复渠道数量
  cannotFixByPrice: boolean;       // 是否所有渠道都不可通过调价修复
  reason: "profit-target" | "logistics-threshold" | "none";
  targetMargin: number | null;
  profitPriceRMB?: number;
  logisticsPriceRMB: number;
}

function getValueLimitRmb(
  channel: ShippingChannel,
  exchangeRate: number,
  valueLimitCurrency: "RMB" | "RUB",
  boundary: "min" | "max"
): number | undefined {
  const rmbValue = boundary === "min" ? channel.minValue : channel.maxValue;
  const rubValue = boundary === "min" ? channel.minValueRUB : channel.maxValueRUB;

  if (valueLimitCurrency === "RMB") {
    if (rmbValue !== undefined && rmbValue !== null) return rmbValue;
    if (rubValue !== undefined && rubValue !== null) return rubToCny(rubValue, exchangeRate);
    return boundary === "min" ? 0 : undefined;
  }

  if (rubValue !== undefined && rubValue !== null) return rubToCny(rubValue, exchangeRate);
  if (rmbValue !== undefined && rmbValue !== null) return rmbValue;
  return boundary === "min" ? 0 : undefined;
}

export function calculateSuggestedPrice(
  unavailableChannels: UnavailableShippingChannel[],
  exchangeRate: number, // RUB/CNY
  valueLimitCurrency: "RMB" | "RUB" = "RMB",
  input?: CalculationInput,
  commission?: CategoryCommission | null,
  targetMargin = 20
): SuggestedPriceResult {
  const fixableChannels: SuggestedPriceResult["fixableChannels"] = [];
  let unfixableCount = 0;

  for (const ch of unavailableChannels) {
    if (!ch.interceptionReasons || ch.interceptionReasons.length === 0) continue;
    
    const hasPriceReason = ch.interceptionReasons.some(r => r.dimension === "货值");
    const hasOtherReason = ch.interceptionReasons.some(r => r.dimension !== "货值");
    
    if (hasPriceReason && !hasOtherReason) {
      const logisticsPriceRMB = getValueLimitRmb(ch, exchangeRate, valueLimitCurrency, "min") || 0;
      const maxPriceRMB = getValueLimitRmb(ch, exchangeRate, valueLimitCurrency, "max");
      const minValueRUB = cnyToRub(logisticsPriceRMB, exchangeRate);

      let profitPriceRMB: number | undefined;
      let reason: "profit-target" | "logistics-threshold" = "logistics-threshold";

      if (input && commission) {
        const reverseResult = reversePriceFromMargin(
          targetMargin,
          { ...input, targetPriceRMB: Math.max(input.targetPriceRMB || 0, logisticsPriceRMB, 100) },
          commission,
          ch
        );

        if (reverseResult.error || reverseResult.priceRMB <= 0) {
          unfixableCount++;
          continue;
        }

        profitPriceRMB = reverseResult.priceRMB;
        reason = "profit-target";
      }

      const suggestedPriceRMB = Math.ceil(Math.max(logisticsPriceRMB, profitPriceRMB || 0));

      if (maxPriceRMB !== undefined && suggestedPriceRMB > maxPriceRMB) {
        unfixableCount++;
        continue;
      }

      if (suggestedPriceRMB > 0) {
        fixableChannels.push({
          channelName: ch.name,
          minValueRUB: cnyToRub(suggestedPriceRMB, exchangeRate),
          minPriceRMB: suggestedPriceRMB,
          suggestedPriceRMB,
          profitPriceRMB,
          logisticsPriceRMB,
          reason,
        });
      }
    } else if (hasOtherReason) {
      // 有非货值拦截 → 不可修复
      unfixableCount++;
    }
  }

  // 按售价升序排列
  fixableChannels.sort((a, b) => a.minPriceRMB - b.minPriceRMB);

  const best = fixableChannels[0];
  return {
    suggestedPriceRMB: best?.suggestedPriceRMB || 0,
    suggestedPriceRUB: best ? cnyToRub(best.suggestedPriceRMB, exchangeRate) : 0,
    channelName: best?.channelName || "",
    fixableChannels,
    unfixableChannelCount: unfixableCount,
    cannotFixByPrice: fixableChannels.length === 0 && unfixableCount > 0,
    reason: best?.reason || "none",
    targetMargin: best?.reason === "profit-target" ? targetMargin : null,
    profitPriceRMB: best?.profitPriceRMB,
    logisticsPriceRMB: best?.logisticsPriceRMB || 0,
  };
}
