"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  Lightbulb,
  Package,
  CheckCircle2,
  Circle,
  Ban,
  Clock,
  Ruler,
  Weight,
  Zap,
  Search,
  Filter,
  Truck,
  X,
  Copy,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Slider } from "@/components/ui/slider";
import { CategoryCommission, CalculationResult, CalculationInput, ShippingChannel } from "@/lib/types";
import { calculateShippingCost } from "@/lib/data-hub-context";
import { getCommissionRate, getCommissionTiersForMode, calculateMarginalContribution, calculateNetProfit, detectShippingDimensionLimits } from "@/lib/calculator";
import { cnyToRub, rubToCny } from "@/lib/currency";
import { calculateOzonBackendPricing } from "@/lib/ozon-pricing";
import { isProfitMarginBelowThreshold } from "@/lib/profit-threshold";
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface DashboardProps {
  result: CalculationResult;
  input: CalculationInput;
  // 🔹 竞品价格对比
  rivalPrice?: number;
  rivalCurrency?: 'RMB' | 'RUB';
  // 🔹 利润预警阈值 (null = 关闭)
  profitWarningThreshold?: number | null;
  shippingChannels: {
    available: ShippingChannel[];
    unavailable: (ShippingChannel & { reason: string })[];
  };
  allShippingChannels: ShippingChannel[];
  selectedChannel: ShippingChannel | null;
  onSelectChannel: (channel: ShippingChannel) => void;
  profitCurve: { priceRMB: number; priceRUB: number; profit: number; commissionRate: number }[];
  stressTest: {
    at5PercentDrop: number;
    at10PercentDrop: number;
    zeroProfitRate: number;
  };
  multiItemProfit: {
    profitPerItem: number;
    totalProfit: number;
    profitMargin: number;
  } | null;
  sixTierPricing: Array<{
    label: string;
    profitMargin: number;
    priceRMB: number;
    priceRUB: number;
    description: string;
    color: string;
    disabled: boolean;
    error?: string;
  }>;
  // 用于汇率抗压滑块计算
  commission?: CategoryCommission;
  onCopyOzonPrice?: (label: string, value: string) => void;
  onApplyPrice?: (priceRMB: number) => void;
}

const COST_COLORS = ["#6366F1", "#F59E0B", "#8B5CF6", "#EF4444", "#10B981", "#EC4899"];

function getFinanceTextClass(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "text-slate-700";
  }
  return value >= 0 ? "text-red-700" : "text-emerald-700";
}

function getFinancePanelClass(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "bg-slate-50 border border-slate-200";
  }
  return value >= 0 ? "bg-red-50/80 border border-red-200" : "bg-emerald-50/80 border border-emerald-200";
}

export function Dashboard({
  result,
  input,
  rivalPrice,
  rivalCurrency = 'RMB',
  profitWarningThreshold,
  shippingChannels,
  allShippingChannels,
  selectedChannel,
  onSelectChannel,
  profitCurve,
  stressTest,
  multiItemProfit,
  sixTierPricing,
  commission,
  onCopyOzonPrice,
  onApplyPrice,
}: DashboardProps) {
  const E = input.exchangeRate; // CNY/RUB (1 CNY = X RUB)
  const [advisorExpanded, setAdvisorExpanded] = useState(true);
  const [chartsExpanded, setChartsExpanded] = useState(true);

  // ====== 客户端渲染标记 ======
  const [isClient, setIsClient] = useState(false);
  useEffect(() => {
    setIsClient(true);
  }, []);
  
  // 🔹 防御性数值格式化函数
  const safeNumber = (value: number | undefined | null, fallback: string = "—"): string => {
    if (value === undefined || value === null || isNaN(value) || !isFinite(value)) {
      return fallback;
    }
    return value.toFixed(2);
  };
  
  const safePercent = (value: number | undefined | null, fallback: string = "—"): string => {
    if (value === undefined || value === null || isNaN(value) || !isFinite(value)) {
      return fallback;
    }
    return `${value.toFixed(1)}%`;
  };
  
  const safeCurrency = (value: number | undefined | null, currency: string = "¥"): string => {
    if (value === undefined || value === null || isNaN(value) || !isFinite(value)) {
      return "—";
    }
    return `${currency}${value.toFixed(2)}`;
  };
  
  // ====== 汇率抗压滑块状态 ======
  const [customDropPercent, setCustomDropPercent] = useState(0);
  
  const exchangeScenarioBase = useMemo(() => {
    const frontPriceRUB = cnyToRub(input.targetPriceRMB, input.exchangeRate);
    const cpaRateForM = input.cpaEnabled ? input.cpaRate : 0;
    const cpcSalesPercent =
      input.cpcEnabled && (input.cpcBillingMode || "bidCvr") === "salesPercent"
        ? input.cpcSalesPercent || 0
        : 0;
    const fixedCost =
      result.costs.total -
      result.costs.commission -
      result.costs.withdrawalFee -
      result.costs.paymentFee -
      result.costs.cpaCost -
      (cpcSalesPercent > 0 ? result.costs.cpcCost : 0);

    return { frontPriceRUB, cpaRateForM, cpcSalesPercent, fixedCost };
  }, [input, result.costs]);

  const calculateExchangeScenario = useCallback((worsenPercent: number) => {
    const safeRate = input.exchangeRate > 0 ? input.exchangeRate : 0;
    const nextExchangeRate = safeRate * (1 + worsenPercent / 100);
    const priceRMB = nextExchangeRate > 0 ? rubToCny(exchangeScenarioBase.frontPriceRUB, nextExchangeRate) : 0;

    if (!commission || safeRate <= 0 || exchangeScenarioBase.frontPriceRUB <= 0) {
      return {
        worsenPercent,
        exchangeRate: nextExchangeRate,
        priceRMB,
        profit: worsenPercent === 0 ? result.netProfit : 0,
        commissionRate: result.commissionRate,
      };
    }

    const commissionRate = getCommissionRate(
      commission,
      exchangeScenarioBase.frontPriceRUB,
      input.fulfillmentMode || "RFBS"
    );
    const baseM = calculateMarginalContribution(
      commissionRate,
      input.withdrawalFee,
      exchangeScenarioBase.cpaRateForM,
      input.paymentFee
    );
    const marginAfterSalesCpc = baseM - Math.max(0, exchangeScenarioBase.cpcSalesPercent || 0) / 100;
    const profit =
      marginAfterSalesCpc > 0
        ? calculateNetProfit(priceRMB, marginAfterSalesCpc, exchangeScenarioBase.fixedCost)
        : -exchangeScenarioBase.fixedCost;

    return { worsenPercent, exchangeRate: nextExchangeRate, priceRMB, profit, commissionRate };
  }, [
    commission,
    exchangeScenarioBase,
    input.exchangeRate,
    input.fulfillmentMode,
    input.paymentFee,
    input.withdrawalFee,
    result.commissionRate,
    result.netProfit,
  ]);

  // ====== 搜索与筛选状态 ======
  const [searchTerm, setSearchTerm] = useState("");
  const [filterServiceLevel, setFilterServiceLevel] = useState<string>("all");
  const activeCommissionTiers = commission ? getCommissionTiersForMode(commission, input.fulfillmentMode || "RFBS") : [];
  const inactiveCommissionMode = (input.fulfillmentMode || "RFBS") === "RFBS" ? "FBP" : "RFBS";
  const inactiveCommissionTiers = commission ? getCommissionTiersForMode(commission, inactiveCommissionMode) : [];

  // 提取所有唯一的服务等级
  const allServiceLevels = useMemo(() => {
    const levels = new Set<string>();
    allShippingChannels.forEach((ch) => {
      if (ch.serviceLevel) levels.add(ch.serviceLevel);
    });
    return Array.from(levels).sort();
  }, [allShippingChannels]);

  // 成本结构环形图数据
  const costChartData = useMemo(() => {
    const data = [
      { name: "采购+头程+包装", value: result.costs.purchase + result.costs.domesticShipping + result.costs.packaging },
      { name: "跨境运费", value: result.costs.internationalShipping },
      { name: "平台佣金", value: result.costs.commission },
      { name: "提现手续费", value: result.costs.withdrawalFee },
      { name: "支付手续费", value: result.costs.paymentFee },
      { name: "广告支出", value: result.costs.cpaCost + result.costs.cpcCost },
      { name: "退货损耗", value: result.costs.returnCost },
      ...(result.taxes?.enabled
        ? [
            { name: "增值税估算", value: result.taxes.vatPayable },
            { name: "企业所得税", value: result.taxes.corporateTax },
          ]
        : []),
    ].filter((d) => d.value > 0);
    
    // 🔹 计算总成本验证
    const chartTotal = data.reduce((sum, item) => sum + item.value, 0);
    const costTotal = result.costs.total;
    
    return data;
  }, [result.costs, result.taxes]);

  // 运费对比柱状图数据（前5名最便宜渠道）
  const shippingChartData = useMemo(() => {
    return shippingChannels.available.slice(0, 5).map((ch) => {
      const cost = calculateShippingCost(ch, result.chargeableWeight);
      return { name: ch.name.length > 10 ? ch.name.slice(0, 10) + "…" : ch.name, cost: parseFloat(cost.toFixed(2)), days: ch.deliveryTime };
    });
  }, [shippingChannels.available, result.chargeableWeight]);

  // 不可用渠道的ID集合
  const unavailableIds = useMemo(() => {
    return new Set(shippingChannels.unavailable.map((c) => c.id));
  }, [shippingChannels.unavailable]);

  // 不可用原因映射
  const unavailableReasons = useMemo(() => {
    const map = new Map<string, string>();
    shippingChannels.unavailable.forEach((c) => {
      map.set(c.id, c.reason);
    });
    return map;
  }, [shippingChannels.unavailable]);

  // 最快时效渠道
  const fastestChannelId = useMemo(() => {
    if (shippingChannels.available.length === 0) return null;
    return shippingChannels.available.reduce(
      (min, c) => (c.deliveryTime < min.deliveryTime ? c : min),
      shippingChannels.available[0]
    ).id;
  }, [shippingChannels.available]);

  // 最便宜渠道
  const cheapestChannelId = useMemo(() => {
    if (shippingChannels.available.length === 0) return null;
    return shippingChannels.available[0].id;
  }, [shippingChannels.available]);

  // 双重排序逻辑：可用渠道在前（按价格），不可用渠道在后（按名称）
  const sortedChannels = useMemo(() => {
    // 可用渠道：按运费从低到高排序
    const availableSorted = [...shippingChannels.available].sort((a, b) => {
      const costA = calculateShippingCost(a, result.chargeableWeight);
      const costB = calculateShippingCost(b, result.chargeableWeight);
      return costA - costB;
    });

    // 不可用渠道：按名称排序
    const unavailableSorted = [...shippingChannels.unavailable].sort((a, b) => 
      a.name.localeCompare(b.name, 'zh-CN')
    );

    return { available: availableSorted, unavailable: unavailableSorted };
  }, [shippingChannels.available, shippingChannels.unavailable, result.chargeableWeight]);

  // ====== 搜索与筛选逻辑（结合排序） ======
  const filteredChannels = useMemo(() => {
    const matchesSearch = (channel: ShippingChannel) => {
      if (!searchTerm.trim()) return true;
      const term = searchTerm.toLowerCase();
      return (
        channel.name?.toLowerCase().includes(term) ||
        channel.thirdParty?.toLowerCase().includes(term) ||
        channel.serviceLevel?.toLowerCase().includes(term) ||
        channel.serviceTier?.toLowerCase().includes(term)
      );
    };

    const matchesFilter = (channel: ShippingChannel) => {
      if (filterServiceLevel === "all") return true;
      return channel.serviceLevel === filterServiceLevel;
    };

    // 过滤可用渠道
    const availableFiltered = sortedChannels.available.filter(
      (ch) => matchesSearch(ch) && matchesFilter(ch)
    );

    // 过滤不可用渠道
    const unavailableFiltered = sortedChannels.unavailable.filter(
      (ch) => matchesSearch(ch) && matchesFilter(ch)
    );

    return { available: availableFiltered, unavailable: unavailableFiltered };
  }, [sortedChannels, searchTerm, filterServiceLevel]);

  // 利润为正/负的颜色
  const isProfit = result.netProfit >= 0;

  // 将 RMB 阶梯定价转为显示
  const formatPrice = (rmb: number) => {
    if (!rmb || rmb === Infinity) return "—";
    return `¥${rmb.toFixed(2)}`;
  };

  const formatPriceWithRUB = (rmb: number) => {
    if (!rmb || rmb === Infinity) return "—";
    const rub = E > 0 ? rmb * E : 0;
    return `¥${rmb.toFixed(2)} (≈${Math.ceil(rub)} ₽)`;
  };

  // 计算利润率：利润率 = (售价 - 总成本) / 售价 × 100%
  const calcProfitMargin = (priceRMB: number) => {
    if (!priceRMB || priceRMB === Infinity || priceRMB === 0) return null;
    const margin = ((priceRMB - result.costs.total) / priceRMB) * 100;
    return margin;
  };

  const advisorActions = useMemo(() => {
    const actions: Array<{
      title: string;
      reason: string;
      impact: string;
      tone: "red" | "amber" | "green" | "blue";
    }> = [];

    const targetMargin = profitWarningThreshold ?? 15;
    if (result.netProfit < 0 || isProfitMarginBelowThreshold(result.profitMargin, targetMargin)) {
      const gap = Math.max(0, targetMargin - result.profitMargin);
      const suggestedTier = sixTierPricing.find((tier) => !tier.disabled && tier.profitMargin >= targetMargin);
      actions.push({
        title: suggestedTier ? `售价调至 ¥${suggestedTier.priceRMB.toFixed(2)}` : "提高售价或降低固定成本",
        reason: result.netProfit < 0 ? "当前单件为亏损状态" : `当前利润率低于 ${targetMargin}% 经营阈值`,
        impact: suggestedTier ? `目标 ${suggestedTier.label}，预计利润率 ${suggestedTier.profitMargin}%` : `利润率缺口约 ${gap.toFixed(1)} 个点`,
        tone: result.netProfit < 0 ? "red" : "amber",
      });
    }

    if (shippingChannels.available.length === 0) {
      actions.push({
        title: "先修复物流可发性",
        reason: `当前 ${shippingChannels.unavailable.length} 条渠道均被拦截`,
        impact: "查看顶部诊断，按货值/重量/尺寸/属性逐项排查",
        tone: "red",
      });
    } else if (result.isVolumetric) {
      actions.push({
        title: "优化包装尺寸",
        reason: `计费重 ${result.chargeableWeight.toFixed(0)}g 高于实重 ${input.weight.toFixed(0)}g`,
        impact: `抛重约 ${result.volumetricWeight.toFixed(0)}g，优先压缩长宽高`,
        tone: "amber",
      });
    }

    if (result.adRiskControl?.isOverBudget) {
      actions.push({
        title: "降低广告出价或关闭广告",
        reason: `当前 ACOS ${result.adRiskControl.currentACOS.toFixed(1)}% 超过保本 ${result.adRiskControl.breakEvenACOS.toFixed(1)}%`,
        impact: "先恢复单件毛利，再重新测试 CPA/CPC",
        tone: "red",
      });
    }

    const tenPercentWorse = calculateExchangeScenario(10);
    if (tenPercentWorse.profit < 0) {
      actions.push({
        title: "增加汇率安全缓冲",
        reason: "回款汇率恶化 10% 后利润转负",
        impact: `10% 压力利润 ¥${tenPercentWorse.profit.toFixed(2)}`,
        tone: "amber",
      });
    }

    if (selectedChannel && shippingChannels.available.length > 1) {
      const cheaper = shippingChannels.available
        .map((channel) => ({ channel, cost: calculateShippingCost(channel, result.chargeableWeight) }))
        .filter((item) => item.channel.id !== selectedChannel.id)
        .sort((a, b) => a.cost - b.cost)[0];
      const currentCost = calculateShippingCost(selectedChannel, result.chargeableWeight);
      if (cheaper && cheaper.cost + 0.5 < currentCost) {
        actions.push({
          title: `换到 ${cheaper.channel.thirdParty || cheaper.channel.name}`,
          reason: "存在更低运费的可用渠道",
          impact: `预计每单节省 ¥${(currentCost - cheaper.cost).toFixed(2)}`,
          tone: "blue",
        });
      }
    }

    if (result.taxes?.enabled && result.taxes.afterTaxNetProfit < result.netProfit) {
      actions.push({
        title: "按税后利润复核售价",
        reason: "已开启税务模拟，默认净利不再代表最终留存",
        impact: `税后净利 ¥${result.taxes.afterTaxNetProfit.toFixed(2)}`,
        tone: result.taxes.afterTaxNetProfit >= 0 ? "blue" : "red",
      });
    }

    if (actions.length === 0) {
      actions.push({
        title: "当前参数可进入下一步",
        reason: "利润、物流和广告风险未触发严重预警",
        impact: "可继续做竞品价格或批量 SKU 对比",
        tone: "green",
      });
    }

    return actions.slice(0, 4);
  }, [calculateExchangeScenario, input.weight, profitWarningThreshold, result, selectedChannel, shippingChannels, sixTierPricing]);

  const verdict = result.netProfit < 0
    ? { label: "不建议上架", className: "bg-red-50 text-red-700 border-red-200" }
    : shippingChannels.available.length === 0
      ? { label: "物流不可发", className: "bg-red-50 text-red-700 border-red-200" }
      : isProfitMarginBelowThreshold(result.profitMargin, profitWarningThreshold ?? 10)
        ? { label: "谨慎测试", className: "bg-amber-50 text-amber-700 border-amber-200" }
        : { label: "可进入测试", className: "bg-emerald-50 text-emerald-700 border-emerald-200" };

  const recommendedTierIndex = useMemo(() => {
    const direct = sixTierPricing.findIndex((tier) => !tier.disabled && (tier.label.includes("常规") || tier.label.includes("推荐")));
    if (direct >= 0) return direct;
    const fallback = sixTierPricing.findIndex((tier) => !tier.disabled && tier.profitMargin >= 20);
    return fallback >= 0 ? fallback : Math.max(0, Math.min(2, sixTierPricing.length - 1));
  }, [sixTierPricing]);

  const recommendedTier = sixTierPricing[recommendedTierIndex];
  const selectedShippingName = selectedChannel?.thirdParty || selectedChannel?.name || shippingChannels.available[0]?.thirdParty || shippingChannels.available[0]?.name || "暂无可用物流";
  const targetMarginFloor = Math.max(0, profitWarningThreshold ?? 0);
  const targetProfitFloor = input.targetPriceRMB > 0 ? input.targetPriceRMB * (targetMarginFloor / 100) : 0;
  const currentAdCost = result.costs.cpaCost + result.costs.cpcCost;
  const profitBeforeAds = result.netProfit + currentAdCost;
  const breakEvenAdCost = Math.max(0, profitBeforeAds);
  const breakEvenAcosLimit = input.targetPriceRMB > 0
    ? (result.adRiskControl?.breakEvenACOS ?? (breakEvenAdCost / input.targetPriceRMB) * 100)
    : 0;
  const targetProfitAdRoom = result.netProfit - targetProfitFloor;
  const testAcosLimit = Math.max(0, breakEvenAcosLimit * 0.7);
  const isBelowTargetProfitAfterAds = !result.adRiskControl?.isOverBudget && targetProfitAdRoom < 0;

  const costSegments = useMemo(() => {
    const items = [
      { label: "采购成本", value: result.costs.purchase + result.costs.domesticShipping + result.costs.packaging, color: "#5B5CF6" },
      { label: "物流费用", value: result.costs.internationalShipping, color: "#F59E0B" },
      { label: "平台佣金", value: result.costs.commission, color: "#3B82F6" },
      { label: "支付手续费", value: result.costs.paymentFee + result.costs.withdrawalFee, color: "#22C55E" },
      { label: "退损预估", value: result.costs.returnCost, color: "#EC4899" },
      { label: "广告费用", value: result.costs.cpaCost + result.costs.cpcCost, color: "#8B5CF6" },
    ].filter((item) => item.value > 0);
    const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
    return items.map((item) => ({ ...item, percent: (item.value / total) * 100 }));
  }, [result.costs]);

  const sensitivityData = useMemo(() => {
    return [-15, -10, -5, 0, 5, 10, 15].map((percent) => {
      const scenario = calculateExchangeScenario(percent);
      return {
        label: percent === 0 ? "当前" : `${percent > 0 ? "+" : ""}${percent}%`,
        value: scenario.profit,
        rate: scenario.exchangeRate,
        priceRMB: scenario.priceRMB,
      };
    });
  }, [calculateExchangeScenario]);

  const exchangeRiskRows = useMemo(() => {
    return [5, 10, 15].map((percent) => calculateExchangeScenario(percent));
  }, [calculateExchangeScenario]);

  const manualExchangeScenario = useMemo(() => {
    return calculateExchangeScenario(customDropPercent);
  }, [calculateExchangeScenario, customDropPercent]);

  const breakEvenExchangeRate = useMemo(() => {
    if (!commission || result.netProfit <= 0 || input.exchangeRate <= 0) return null;
    let low = input.exchangeRate;
    let high = input.exchangeRate * 2;
    let highProfit = calculateExchangeScenario(100).profit;

    while (highProfit > 0 && high < input.exchangeRate * 8) {
      high *= 1.5;
      const worsenPercent = ((high / input.exchangeRate) - 1) * 100;
      highProfit = calculateExchangeScenario(worsenPercent).profit;
    }

    if (highProfit > 0) return null;

    for (let index = 0; index < 36; index += 1) {
      const mid = (low + high) / 2;
      const worsenPercent = ((mid / input.exchangeRate) - 1) * 100;
      const profit = calculateExchangeScenario(worsenPercent).profit;
      if (profit > 0) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return high;
  }, [calculateExchangeScenario, commission, input.exchangeRate, result.netProfit]);

  const adImpactRows = useMemo(() => {
    return [5, 10, 15].map((acos) => {
      const adCost = input.targetPriceRMB * (acos / 100);
      const profit = profitBeforeAds - adCost;
      return {
        acos,
        adCost,
        profit,
        margin: input.targetPriceRMB > 0 ? (profit / input.targetPriceRMB) * 100 : 0,
      };
    });
  }, [input.targetPriceRMB, profitBeforeAds]);

  return (
    <div className="space-y-3 pr-1">
      <Card className="border-slate-200 shadow-none">
        <CardHeader className="px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base font-black text-slate-800">核心财务指标</CardTitle>
            <span className={`rounded-md border px-2 py-1 text-xs font-black ${verdict.className}`}>{verdict.label}</span>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 pb-4 xl:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="mb-3 flex items-center justify-between text-xs">
              <span className="font-bold text-slate-700">成本结构占比</span>
              <span className="text-slate-500">售价：¥{input.targetPriceRMB.toFixed(2)}</span>
            </div>
            <div className="flex h-11 overflow-hidden rounded-lg bg-slate-100">
              {costSegments.map((segment) => (
                <div
                  key={segment.label}
                  className="flex items-center justify-center text-[11px] font-black text-white"
                  style={{ width: `${Math.max(segment.percent, 4)}%`, backgroundColor: segment.color }}
                  title={`${segment.label} ${segment.percent.toFixed(1)}%`}
                >
                  {segment.percent >= 9 ? `${segment.percent.toFixed(1)}%` : ""}
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {costSegments.map((segment) => (
                <div key={segment.label} className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: segment.color }} />
                  <span>{segment.label}</span>
                  <b className="ml-auto">¥{segment.value.toFixed(2)}</b>
                </div>
              ))}
            </div>
            <div className="mt-4 inline-flex rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
              <span className="text-slate-500">总成本：</span>
              <b className="text-slate-800">¥{result.costs.total.toFixed(2)}</b>
            </div>
            <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
              总成本已包含采购、物流、佣金、手续费、退损、广告等成本项。
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-bold text-slate-700">利润敏感性分析</span>
              <span className="text-slate-500">当前汇率：1 CNY = {input.exchangeRate.toFixed(2)} RUB</span>
            </div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height={220} minWidth={260}>
                <LineChart data={sensitivityData} margin={{ left: 4, right: 12, top: 16, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(value) => `¥${value}`} />
                  <RechartsTooltip
                    formatter={(value) => [`¥${Number(value).toFixed(2)}`, "利润"]}
                    labelFormatter={(label, payload) => {
                      const row = payload?.[0]?.payload as { rate?: number; priceRMB?: number } | undefined;
                      return row ? `${label} | 1 CNY = ${row.rate?.toFixed(2)} RUB | 回款 ¥${row.priceRMB?.toFixed(2)}` : String(label);
                    }}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                  <ReferenceLine x="当前" stroke="#94a3b8" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="value" stroke="#5B5CF6" strokeWidth={3} dot={{ r: 4, fill: "#fff", strokeWidth: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-none">
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-base font-black text-slate-800">定价建议矩阵 <span className="ml-1 text-xs font-medium text-slate-400">（基于当前成本结构）</span></CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid gap-2 md:grid-cols-3 2xl:grid-cols-6">
            {sixTierPricing.map((tier, index) => {
              const colorConfig: Record<string, { border: string; bg: string; text: string; badge: string; soft: string }> = {
                red: { border: "border-red-200", bg: "bg-red-50/80", text: "text-red-700", badge: "bg-red-100 text-red-700", soft: "bg-red-100/70" },
                orange: { border: "border-orange-200", bg: "bg-orange-50/80", text: "text-orange-700", badge: "bg-orange-100 text-orange-700", soft: "bg-orange-100/70" },
                amber: { border: "border-amber-200", bg: "bg-amber-50/80", text: "text-amber-700", badge: "bg-amber-100 text-amber-700", soft: "bg-amber-100/70" },
                green: { border: "border-emerald-200", bg: "bg-emerald-50/80", text: "text-emerald-700", badge: "bg-emerald-100 text-emerald-700", soft: "bg-emerald-100/70" },
                blue: { border: "border-blue-200", bg: "bg-blue-50/80", text: "text-blue-700", badge: "bg-blue-100 text-blue-700", soft: "bg-blue-100/70" },
                purple: { border: "border-purple-200", bg: "bg-purple-50/80", text: "text-purple-700", badge: "bg-purple-100 text-purple-700", soft: "bg-purple-100/70" },
              };
              const colors = colorConfig[tier.color] || colorConfig.green;
              const isRecommended = index === recommendedTierIndex;
              const ozonTierPricing = calculateOzonBackendPricing(tier.priceRMB, input.exchangeRate);

              return (
                <div
                  key={`${tier.label}-${index}`}
                  role="button"
                  tabIndex={tier.disabled ? -1 : 0}
                  aria-disabled={tier.disabled}
                  onClick={() => !tier.disabled && onApplyPrice?.(tier.priceRMB)}
                  onKeyDown={(event) => {
                    if (!tier.disabled && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onApplyPrice?.(tier.priceRMB);
                    }
                  }}
                  className={`min-h-[170px] rounded-xl border p-3 text-left transition-all ${
                    isRecommended
                      ? "border-[#5B5CF6] bg-indigo-50 shadow-[0_0_0_2px_rgba(91,92,246,0.16)]"
                      : `${colors.border} ${colors.bg} hover:border-indigo-200 hover:shadow-sm`
                  } ${tier.disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"}`}
                >
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className={`text-sm font-black ${isRecommended ? "text-[#5B5CF6]" : colors.text}`}>
                      {tier.label.replace("常规价", "推荐价")}
                      {isRecommended && <span className="ml-1 text-[10px] text-slate-500">（当前）</span>}
                    </div>
                    {isRecommended && <span className="rounded-full bg-[#5B5CF6] px-2 py-0.5 text-[10px] font-bold text-white">推荐</span>}
                  </div>
                  {tier.disabled ? (
                    <div className="rounded-lg bg-white/70 px-2 py-2 text-xs font-semibold text-slate-500">{tier.error || "空间不足"}</div>
                  ) : (
                    <>
                      <div className={`text-2xl font-black leading-none tabular-nums ${isRecommended ? "text-[#5B5CF6]" : colors.text}`}>
                        ¥{tier.priceRMB.toFixed(2)}
                      </div>
                      <div className="mt-3 text-sm font-bold text-slate-700">利润率 {tier.profitMargin}%</div>
                      <div className="mt-3 border-t border-slate-200 pt-2 text-xs">
                        <div className="flex justify-between text-slate-600"><span>利润</span><b className={getFinanceTextClass(tier.priceRMB * tier.profitMargin / 100)}>¥{(tier.priceRMB * tier.profitMargin / 100).toFixed(2)}</b></div>
                        <div className="mt-1 text-slate-500">适合：{tier.description}</div>
                      </div>
                      {ozonTierPricing.isValid && (
                        <div className={`mt-3 space-y-1 rounded-lg px-2 py-1.5 text-[10px] text-slate-600 ${colors.soft}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span>后台 ¥{ozonTierPricing.ozonBackendPriceRMB}</span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onCopyOzonPrice?.(`${tier.label} 后台定价`, String(ozonTierPricing.ozonBackendPriceRMB));
                              }}
                              className="rounded p-0.5 text-slate-500 hover:bg-white/70"
                              title="复制后台定价"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span>折扣前 ¥{ozonTierPricing.ozonOriginalPriceRMB}</span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                onCopyOzonPrice?.(`${tier.label} 折扣前价格`, String(ozonTierPricing.ozonOriginalPriceRMB));
                              }}
                              className="rounded p-0.5 text-slate-500 hover:bg-white/70"
                              title="复制折扣前价格"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                          <div className="text-[9px] text-slate-500">
                            RUB：后台 ₽{ozonTierPricing.ozonBackendPriceRUB} / 折扣前 ₽{ozonTierPricing.ozonOriginalPriceRUB}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-none">
        <CardHeader className="px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base font-black text-slate-800">利润演练与汇率模拟</CardTitle>
            <button
              type="button"
              onClick={() => setChartsExpanded((value) => !value)}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-600 hover:border-indigo-200 hover:text-[#5B5CF6]"
            >
              {chartsExpanded ? "收起" : "展开"}
            </button>
          </div>
        </CardHeader>
        {chartsExpanded && (
          <CardContent className="px-4 pb-4">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-bold text-slate-700">利润演练曲线</span>
                <span className="text-slate-500">当前售价 ¥{input.targetPriceRMB.toFixed(2)}</span>
              </div>
              {profitCurve.length > 0 ? (
                <div className="h-60">
                  <ResponsiveContainer width="100%" height={230} minWidth={260}>
                    <LineChart data={profitCurve} margin={{ left: 4, right: 18, top: 16, bottom: 6 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis
                        dataKey="priceRMB"
                        type="number"
                        domain={["dataMin", "dataMax"]}
                        tick={{ fontSize: 11, fill: "#64748b" }}
                        tickFormatter={(value) => `¥${Number(value).toFixed(0)}`}
                      />
                      <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(value) => `¥${Number(value).toFixed(0)}`} />
                      <RechartsTooltip
                        formatter={(value) => [`¥${Number(value).toFixed(2)}`, "利润"]}
                        labelFormatter={(label, payload) => {
                          const row = payload?.[0]?.payload as { priceRUB?: number; commissionRate?: number } | undefined;
                          return row
                            ? `售价 ¥${Number(label).toFixed(2)} | ₽${row.priceRUB?.toFixed(0)} | 佣金 ${row.commissionRate?.toFixed(1)}%`
                            : `售价 ¥${Number(label).toFixed(2)}`;
                        }}
                        contentStyle={{ fontSize: 12 }}
                      />
                      <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                      <ReferenceLine x={input.targetPriceRMB} stroke="#5B5CF6" strokeDasharray="4 4" label={{ value: "当前", fill: "#5B5CF6", fontSize: 11 }} />
                      <Line type="monotone" dataKey="profit" stroke="#5B5CF6" strokeWidth={3} dot={false} activeDot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="rounded-lg bg-slate-50 px-3 py-8 text-center text-sm text-slate-500">暂无利润演练数据</div>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="border-slate-200 shadow-none">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-base font-black text-slate-800">汇率风险测试 <span className="text-xs font-medium text-slate-400">（1 CNY = N RUB）</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-4 pb-4 text-sm">
            {exchangeRiskRows.map((row) => (
              <div
                key={row.worsenPercent}
                className={`grid grid-cols-[1fr_auto] gap-2 rounded-lg border px-3 py-2 ${
                  row.worsenPercent >= 15 ? "border-red-100 bg-red-50" : row.worsenPercent >= 10 ? "border-orange-100 bg-orange-50" : "border-amber-100 bg-amber-50"
                }`}
              >
                <div>
                  <div className="font-bold text-slate-700">回款汇率恶化 {row.worsenPercent}%</div>
                  <div className="mt-0.5 text-xs text-slate-500">1 CNY = {row.exchangeRate.toFixed(2)} RUB，回款 ¥{row.priceRMB.toFixed(2)}</div>
                </div>
                <span className={`self-center font-black ${getFinanceTextClass(row.profit)}`}>利润 ¥{row.profit.toFixed(2)}</span>
              </div>
            ))}
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              {result.netProfit <= 0 ? (
                <span>当前已低于保本口径，需先提高售价或降低固定成本。</span>
              ) : breakEvenExchangeRate ? (
                <span>保本汇率约为 <b>1 CNY = {breakEvenExchangeRate.toFixed(2)} RUB</b>，高于该值后利润转弱。</span>
              ) : (
                <span>当前利润缓冲较高，未在模拟范围内触达保本汇率。</span>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-700">手动模拟回款汇率恶化</span>
                <b className="text-[#5B5CF6]">{customDropPercent}%</b>
              </div>
              <div className="mt-3">
                <Slider
                  value={[customDropPercent]}
                  min={0}
                  max={50}
                  step={1}
                  onValueChange={(value) => setCustomDropPercent(value[0] ?? 0)}
                />
              </div>
              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
                  模拟汇率 <b className="text-slate-800">1 CNY = {manualExchangeScenario.exchangeRate.toFixed(2)} RUB</b>
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
                  模拟净利 <b className={getFinanceTextClass(manualExchangeScenario.profit)}>¥{manualExchangeScenario.profit.toFixed(2)}</b>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-none">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-base font-black text-slate-800">广告投入影响 <span className="text-xs font-medium text-slate-400">（以推荐价计算）</span></CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr className="border-b border-slate-100">
                  <th className="py-2 text-left">ACOS</th>
                  <th className="py-2 text-right">广告花费</th>
                  <th className="py-2 text-right">利润</th>
                  <th className="py-2 text-right">利润率</th>
                </tr>
              </thead>
              <tbody>
                {adImpactRows.map((row) => (
                  <tr key={row.acos} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 font-medium text-slate-600">{row.acos}%</td>
                    <td className="py-2 text-right text-slate-600">¥{row.adCost.toFixed(2)}</td>
                    <td className={`py-2 text-right font-bold ${getFinanceTextClass(row.profit)}`}>¥{row.profit.toFixed(2)}</td>
                    <td className={`py-2 text-right font-bold ${getFinanceTextClass(row.margin)}`}>{row.margin.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              保本广告上限：<b className="text-orange-600">¥{breakEvenAdCost.toFixed(2)}</b>
              <span className="mx-2 text-slate-300">|</span>
              保本 ACOS：<b className="text-orange-600">≤ {breakEvenAcosLimit.toFixed(1)}%</b>
              <span className="mx-2 text-slate-300">|</span>
              建议测试：<b className="text-orange-600">≤ {testAcosLimit.toFixed(1)}%</b>
              <span className={`ml-2 ${targetProfitAdRoom >= 0 ? "text-slate-500" : "font-bold text-amber-700"}`}>
                当前广告后目标剩余 <b className={getFinanceTextClass(targetProfitAdRoom)}>¥{targetProfitAdRoom.toFixed(2)}</b>
              </span>
              {result.adRiskControl?.isOverBudget && (
                <span className="ml-2 font-bold text-red-600">当前广告已超保本，需降广告或提售价。</span>
              )}
              {isBelowTargetProfitAfterAds && (
                <span className="ml-2 font-bold text-amber-700">未超保本，但低于目标利润空间。</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-amber-200 bg-gradient-to-r from-amber-50 to-white shadow-none">
        <CardContent className="p-4">
          <div className="grid gap-3 md:grid-cols-[80px_repeat(5,1fr)]">
            <div className="flex items-center gap-2 text-sm font-black text-slate-800">
              <Lightbulb className="h-5 w-5 text-amber-500" />
              下一步运营建议
            </div>
            {[
              { label: "建议售价", value: recommendedTier ? `¥${recommendedTier.priceRMB.toFixed(0)} - ¥${Math.ceil(recommendedTier.priceRMB * 1.1)}` : `¥${input.targetPriceRMB.toFixed(0)}`, sub: "建议区间", tone: "text-orange-600" },
              { label: "推荐物流", value: selectedShippingName, sub: "性价比优先", tone: "text-slate-800" },
              {
                label: "广告上限",
                value: `¥${breakEvenAdCost.toFixed(2)}`,
                sub: `保本 ACOS ${breakEvenAcosLimit.toFixed(1)}%，当前广告后目标剩余 ¥${targetProfitAdRoom.toFixed(2)}`,
                tone: result.adRiskControl?.isOverBudget ? "text-red-600" : "text-orange-600",
              },
              { label: "主要风险", value: shippingChannels.available.length === 0 ? "物流不可发" : result.isVolumetric ? "计抛偏高" : result.profitMargin < 10 ? "利润偏低" : "关注汇率", sub: "建议复核方案", tone: "text-red-600" },
              { label: "优化方向", value: result.netProfit >= 0 ? "降低采购成本" : "提高售价", sub: "提升利润空间", tone: "text-emerald-700" },
            ].map((item) => (
              <div key={item.label} className="border-l border-amber-200 pl-3 first:border-l-0 first:pl-0">
                <div className="text-[11px] font-bold text-slate-500">{item.label}</div>
                <div className={`mt-1 truncate text-base font-black ${item.tone}`}>{item.value}</div>
                <div className="mt-1 text-[11px] text-slate-500">{item.sub}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
