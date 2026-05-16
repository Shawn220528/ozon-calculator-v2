import type { ValueLimitCurrency } from "./currency";

// 佣金阶梯定义
export interface CommissionTier {
  min: number; // 最小金额（RUB）
  max: number; // 最大金额（RUB）
  rate: number; // 佣金率（百分比）
}

// 类目佣金配置
export interface CategoryCommission {
  primaryCategory: string;
  secondaryCategory: string;
  tiers: CommissionTier[]; // 通常有3个阶梯
}

// 物流渠道定义
export interface ShippingChannel {
  id: string;
  name: string;                    // 配送方式名称
  thirdParty: string;              // 第三方物流 (RETS, ZTO, GUOO, etc.)
  serviceTier: string;             // 评分组 (Extra Small, Small, Big, etc.)
  serviceLevel: string;            // 服务等级 (Economy, Express, Standard, etc.)
  fixFee: number;                  // 固定费 (RMB)
  varFeePerGram: number;           // 每克变动费 (RMB/g)
  pricePerKg: number;              // 每公斤参考价 (RMB) = fixFee + varFeePerGram * 1000 (⚠️ 仅供参考，实际运费由 fixFee + varFeePerGram * 计费重 计算)
  pricePerCubic: number;           // 每立方价格 (RMB)
  minWeight: number;               // 最小重量限制 (g)
  maxWeight: number;               // 最大重量限制 (g)
  maxLength: number;               // 最大长度限制 (cm) - 长边
  maxWidth: number;                // 最大宽度限制 (cm)
  maxHeight: number;               // 最大高度限制 (cm)
  maxSumDimension: number;         // 边长总和限制 (cm)
  deliveryTimeMin: number;         // 最短时效 (天)
  deliveryTimeMax: number;         // 最长时效 (天)
  deliveryTime: number;            // 预计平均时效 (天) = (min+max)/2
  maxValueRUB?: number;            // 最大货值限制 (RUB)
  minValueRUB?: number;             // 最小货值限制 (RUB) - 评分组货值区间下限
  maxValue?: number;               // 最大货值限制 (RMB)
  minValue?: number;               // 最小货值限制 (RMB)
  billingType: string;             // 计费类型 (实际重量/体积重量)
  volumetricDivisor: number;       // 体积重量除数 (如 5000, 6000 等, 0 表示不适用)
  ozonRating: number;              // Ozon评级
  batteryAllowed: boolean;         // 是否允许电池
  liquidAllowed: boolean;          // 是否允许液体
}

// 物流拦截原因类型
export interface ShippingInterceptionReason {
  dimension: "货值" | "实重" | "边长" | "尺寸总和" | "体积重" | "电池" | "液体";
  code: string;
  message: string;
  details?: string;
}

// 不可用的物流渠道（含拦截原因）
export interface UnavailableShippingChannel extends ShippingChannel {
  reason: string;                  // 拦截原因（多维度用分号分隔）
  interceptionReasons: ShippingInterceptionReason[];
}

// 输入参数
export interface CalculationInput {
  // 商品参数
  primaryCategory: string;
  secondaryCategory: string;
  length: number; // cm
  width: number; // cm
  height: number; // cm
  weight: number; // g
  hasBattery: boolean; // 🔹 是否带电
  hasLiquid: boolean; // 🔹 是否带液体
  designatedProviders: string[]; // 🔹 指定物流商数组，为空表示全部
  
  // 成本参数
  purchaseCost: number; // RMB
  domesticShipping: number; // RMB
  packagingFee: number; // RMB
  
  // 退货参数
  returnRate: number; // 百分比
  returnHandling: 'destroy' | 'resell' | 'productOnly'; // 处理方式
  
  // 广告参数
  cpaEnabled: boolean;
  cpaRate: number; // 百分比
  cpcEnabled: boolean;
  cpcBid: number; // RUB
  cpcConversionRate: number; // 百分比
  
  // 定价参数
  targetPriceRMB: number; // RMB (用户以人民币思维输入售价)
  promotionDiscount: number; // 百分比
  
  // 全局设置
  exchangeRate: number; // 汇率：1 CNY = X RUB (例如 12.0，即1元人民币兑换12卢布)
  withdrawalFee: number; // 百分比
  exchangeRateBuffer: number; // 汇率安全缓冲百分比（默认0，用于规避结汇风险）
  valueLimitCurrency: ValueLimitCurrency; // 物流货值限制口径
  
// 经营模拟
  rivalPrice?: number; // 竞品售价
  rivalCurrency?: 'RMB' | 'RUB'; // 竞品售价货币模式
  profitWarningThreshold?: number | null; // 利润率预警阈值
  multiItemCount: number; // 单单购买数量，默认1
  
  // 税务设置（⚠️ 暂未实现计算逻辑，仅预留字段）
  taxEnabled: boolean; // 是否开启税务核算
  vatRate: number; // 增值税率 (%)
  corporateTaxRate: number; // 企业所得税率 (%)
}

// 计算结果
export interface CalculationResult {
  // 核心KPI
  netProfit: number; // RMB
  roi: number; // 百分比
  profitMargin: number; // 百分比
  commissionRate: number; // 当前生效佣金率（百分比），如 12、15、18
  
  // 成本分解
  costs: {
    purchase: number;
    domesticShipping: number;
    packaging: number;
    internationalShipping: number;
    commission: number;
    cpaCost: number;
    cpcCost: number;
    returnCost: number;
    withdrawalFee: number;
    total: number;
  };
  
  // 定价策略
  pricingStrategies: {
    breakEven: number; // RMB
    lowProfit: number; // RMB
    mediumProfit: number; // RMB
    highProfit: number; // RMB
  };
  
  // 物流推荐
  recommendedShipping: ShippingChannel;
  shippingAlternatives: ShippingChannel[];
  
  // 警告和提示
  warnings: string[];
  suggestions: string[];
  
  // 体积重信息
  volumetricWeight: number;
  chargeableWeight: number;
  isVolumetric: boolean;
  
  // 广告风控
  adRiskControl?: {
    breakEvenACOS: number; // 保本 ACOS (%)
    currentACOS: number; // 当前 ACOS (%)
    isOverBudget: boolean; // 是否超预算（广告费超过毛利）
    cvrSensitivity?: { // CVR 灵敏度
      costReduction: number; // 成本下降 (RMB)
      profitIncreasePercent: number; // 利润提升 (%)
      currentCost: number; // 当前成本
      newCost: number; // 新成本
    };
  };
  
  // 智能提醒
  smartAdvisor?: {
    commissionTierBoundary?: { // 佣金跳档提醒
      isNearBoundary: boolean;
      suggestion?: string;
      lowerPriceRUB?: number;
      profitIncrease?: number;
    };
    shippingWeightBoundary?: { // 物流阶梯提醒
      isNearBoundary: boolean;
      suggestion?: string;
      weightToReduce?: number;
      costSaving?: number;
    };
  };
}
