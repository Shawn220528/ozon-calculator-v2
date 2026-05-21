"use client";

import { useMemo, useState, useEffect } from "react";
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
import { CalculationResult, CalculationInput, ShippingChannel } from "@/lib/types";
import { calculateShippingCost } from "@/lib/data-hub-context";
import { calculateExchangeRateStressTest, getCommissionRate, calculateMarginalContribution, calculateNetProfit, detectShippingDimensionLimits } from "@/lib/calculator";
import { cnyToRub, rubToCny } from "@/lib/currency";
import { calculateOzonBackendPricing } from "@/lib/ozon-pricing";
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
  commission?: {
    primaryCategory: string;
    secondaryCategory: string;
    tiers: Array<{ min: number; max: number; rate: number }>;
  };
  onCopyOzonPrice?: (label: string, value: string) => void;
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
  
  // 计算自定义跌幅下的利润
  const customDropProfit = useMemo(() => {
    if (customDropPercent === 0 || !commission) return result.netProfit;
    
    const newExchangeRate = input.exchangeRate * (1 - customDropPercent / 100);
    const priceRUB = cnyToRub(input.targetPriceRMB, input.exchangeRate);
    
    // 获取新汇率下的佣金率
    const commissionRate = getCommissionRate(commission, priceRUB);
    
    // 计算边际贡献率
    const cpaRateForM = input.cpaEnabled ? input.cpaRate : 0;
    const M = calculateMarginalContribution(commissionRate, input.withdrawalFee, cpaRateForM);
    
    // 计算固定成本（从 result 中获取）
    const totalFixedCost = result.costs.total - result.costs.commission - result.costs.withdrawalFee - result.costs.cpaCost;
    
    // 计算新利润
    const newPriceRMB = rubToCny(priceRUB, newExchangeRate);
    return M > 0 ? calculateNetProfit(newPriceRMB, M, totalFixedCost) : -totalFixedCost;
  }, [customDropPercent, input, commission, result]);

  // ====== 搜索与筛选状态 ======
  const [searchTerm, setSearchTerm] = useState("");
  const [filterServiceLevel, setFilterServiceLevel] = useState<string>("all");

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
    if (result.netProfit < 0 || result.profitMargin < targetMargin) {
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

    if (stressTest.at10PercentDrop < 0) {
      actions.push({
        title: "增加汇率安全缓冲",
        reason: "汇率下跌 10% 后利润转负",
        impact: `10% 压力利润 ¥${stressTest.at10PercentDrop.toFixed(2)}`,
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
  }, [input.weight, profitWarningThreshold, result, selectedChannel, shippingChannels, sixTierPricing, stressTest]);

  const verdict = result.netProfit < 0
    ? { label: "不建议上架", className: "bg-red-50 text-red-700 border-red-200" }
    : shippingChannels.available.length === 0
      ? { label: "物流不可发", className: "bg-red-50 text-red-700 border-red-200" }
      : result.profitMargin < (profitWarningThreshold ?? 10)
        ? { label: "谨慎测试", className: "bg-amber-50 text-amber-700 border-amber-200" }
        : { label: "可进入测试", className: "bg-emerald-50 text-emerald-700 border-emerald-200" };

  return (
    <div className="space-y-2 pr-1">
      {/* 警告信息已移至左侧 Live Monitor Console */}

      {/* 卡片 0：经营结论与推荐动作 */}
      <Card className="border-slate-200 shadow-none">
        <CardContent className="p-2.5">
          <button
            type="button"
            onClick={() => setAdvisorExpanded((expanded) => !expanded)}
            className="flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={advisorExpanded}
            data-testid="advisor-toggle"
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-indigo-50 text-[#6366F1]">
                <Lightbulb className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-800">经营结论</span>
                  <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${verdict.className}`}>
                    {verdict.label}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs text-slate-500">
                  {advisorActions[0]?.title} · {advisorActions[0]?.impact}
                </div>
              </div>
            </div>
            <span className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              {advisorExpanded ? "收起" : `展开 ${advisorActions.length} 条`}
            </span>
          </button>

          {advisorExpanded && (
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-slate-100 pt-3">
            {advisorActions.map((action, index) => {
              const toneClass = {
                red: "border-red-200 bg-red-50 text-red-800",
                amber: "border-amber-200 bg-amber-50 text-amber-800",
                green: "border-emerald-200 bg-emerald-50 text-emerald-800",
                blue: "border-blue-200 bg-blue-50 text-blue-800",
              }[action.tone];
              return (
                <div key={`${action.title}-${index}`} className={`rounded-lg border p-3 ${toneClass}`}>
                  <div className="text-sm font-bold">{action.title}</div>
                  <div className="mt-1 text-[11px] leading-relaxed opacity-85">{action.reason}</div>
                  <div className="mt-2 rounded bg-white/60 px-2 py-1 text-[11px] font-medium">{action.impact}</div>
                </div>
              );
            })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 卡片 1：财务精算与成本结构图 */}
      <Card className="shadow-none">
        <CardHeader className="px-3 py-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">财务精算与成本结构</CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-xs px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 font-bold border border-orange-200">
                佣金率 {result.commissionRate}%
              </span>
              {commission && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium cursor-help border border-blue-200">
                        阶梯佣金
                      </span>
                    </TooltipTrigger>
                    <TooltipContent 
                      side="top" 
                      sideOffset={8}
                      className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3"
                    >
                      <div className="space-y-1 text-xs">
                        <p className="font-semibold">佣金阶梯费率</p>
                        {commission.tiers.map((tier, i) => {
                          const isMatched = result.commissionRate === tier.rate;
                          return (
                            <div key={i} className={`flex justify-between gap-4 ${isMatched ? 'text-blue-700 font-bold' : 'text-muted-foreground'}`}>
                              <span>{tier.min}-{tier.max === Infinity ? '∞' : tier.max} RUB</span>
                              <span>{tier.rate}%{isMatched && ' ✓'}</span>
                            </div>
                          );
                        })}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          {/* 🔹 利润预警提示 */}
          {profitWarningThreshold !== undefined && profitWarningThreshold !== null && result.profitMargin < profitWarningThreshold && (
            <div className="mb-3 flex items-center justify-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-center">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
              <div className="text-sm text-amber-800">
                利润率 <span className="font-bold">{result.profitMargin.toFixed(1)}%</span> 低于预警阈值 <span className="font-bold">{profitWarningThreshold}%</span>
              </div>
            </div>
          )}

          {result.taxes?.enabled && (
            <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">含税口径</span>
                <span className="text-[11px] text-slate-500">
                  VAT {result.taxes.vatRate}% / 所得税 {result.taxes.corporateTaxRate}%
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-xs">
                <div className="rounded border bg-white px-2 py-1.5">
                  <div className="text-slate-500">税前净利</div>
                  <div className={`mt-1 font-bold ${getFinanceTextClass(result.taxes.preTaxNetProfit)}`}>¥{result.taxes.preTaxNetProfit.toFixed(2)}</div>
                </div>
                <div className="rounded border bg-white px-2 py-1.5">
                  <div className="text-slate-500">增值税估算</div>
                  <div className="mt-1 font-bold text-amber-700">¥{result.taxes.vatPayable.toFixed(2)}</div>
                </div>
                <div className="rounded border bg-white px-2 py-1.5">
                  <div className="text-slate-500">企业所得税</div>
                  <div className="mt-1 font-bold text-amber-700">¥{result.taxes.corporateTax.toFixed(2)}</div>
                </div>
                <div className="rounded border bg-white px-2 py-1.5">
                  <div className="text-slate-500">税后净利</div>
                  <div className={`mt-1 font-bold ${getFinanceTextClass(result.taxes.afterTaxNetProfit)}`}>
                    ¥{result.taxes.afterTaxNetProfit.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 🔹 竞品价格对比 */}
          {rivalPrice && rivalPrice > 0 && input.targetPriceRMB > 0 ? (
            <div className="mb-2 flex items-center justify-between rounded-lg border bg-slate-50 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-1">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help">vs 竞品售价</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3">
                      <div className="space-y-1">
                        <p className="font-medium text-sm">与竞品价格对比</p>
                        <p className="text-xs text-slate-600">
                          与竞品售价的差额，正数表示高于竞品
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {(() => {
                const rivalInRMB = rivalCurrency === 'RUB' ? rivalPrice / input.exchangeRate : rivalPrice;
                const isHigher = input.targetPriceRMB >= rivalInRMB;
                const diff = input.targetPriceRMB - rivalInRMB;
                return (
                  <>
                    <div className={`text-base font-bold ${isHigher ? "text-green-600" : "text-red-600"}`}>
                      {isHigher ? "+" : ""}¥{diff.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      vs {rivalCurrency === 'RUB' ? `₽${rivalPrice.toFixed(0)}` : `¥${rivalPrice.toFixed(2)}`}
                    </div>
                  </>
                );
              })()}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setChartsExpanded((expanded) => !expanded)}
            className="flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            <span>图表与压力测试</span>
            <span>{chartsExpanded ? "收起" : "展开详情"}</span>
          </button>

          {/* 成本结构环形图 - 默认折叠 */}
          {chartsExpanded && (
          <div className="mt-3 flex min-h-56 items-center">
            <div className="w-1/2 h-64 min-w-0">
              <ResponsiveContainer width="100%" height={240} minWidth={240}>
                <PieChart>
                  <Pie
                    data={costChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={65}
                    paddingAngle={2}
                    dataKey="value"
                    labelLine={true}
                    label={({ percent }) => `${((percent ?? 0) * 100).toFixed(1)}%`}
                    isAnimationActive={true}
                  >
                    {costChartData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COST_COLORS[index % COST_COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    formatter={(value, name) => [`¥${Number(value).toFixed(2)}`, name]}
                    contentStyle={{ fontSize: 12 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* 侧边图例 - 带颜色块 + 动态文字增强 */}
            <div className="w-1/2 pl-4 space-y-1">
              <div className="text-xs text-muted-foreground mb-2">单位: ¥</div>
              {costChartData.map((item, index) => {
                // 动态文字增强
                let enhancedName = item.name;
                if (item.name === "平台佣金") {
                  enhancedName = `平台佣金 (${result.commissionRate}%)`;
                } else if (item.name === "提现手续费") {
                  enhancedName = `提现手续费 (${input.withdrawalFee.toFixed(1)}%)`;
                }
                
                return (
                  <div key={index} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: COST_COLORS[index % COST_COLORS.length] }} />
                      <span className="text-slate-600">{enhancedName}</span>
                    </div>
                    <span className="font-medium text-slate-700">{item.value.toFixed(2)}</span>
                  </div>
                );
              })}
              <div className="flex items-center justify-between text-xs pt-2 border-t font-semibold">
                <span className="text-slate-600">总成本</span>
                <span className="text-slate-800">{result.costs.total.toFixed(2)}</span>
              </div>
            </div>
          </div>
          )}
        </CardContent>
      </Card>

      {/* 卡片 2：六档定价推荐矩阵 */}
      <Card className="shadow-none">
        <CardHeader className="px-3 py-2">
          <CardTitle className="text-base">六档定价推荐矩阵</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          {/* 六档定价推荐卡片 */}
          <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
            {sixTierPricing.map((tier, index) => {
              // 色彩映射
              const colorConfig: Record<string, { border: string; bg: string; text: string; badge: string }> = {
                red: { border: "border-red-300", bg: "bg-red-50", text: "text-red-700", badge: "bg-red-100 text-red-700" },
                orange: { border: "border-orange-300", bg: "bg-orange-50", text: "text-orange-700", badge: "bg-orange-100 text-orange-700" },
                amber: { border: "border-amber-300", bg: "bg-amber-50", text: "text-amber-700", badge: "bg-amber-100 text-amber-700" },
                green: { border: "border-green-300", bg: "bg-green-50", text: "text-green-700", badge: "bg-green-100 text-green-700" },
                blue: { border: "border-blue-300", bg: "bg-blue-50", text: "text-blue-700", badge: "bg-blue-100 text-blue-700" },
                purple: { border: "border-purple-300", bg: "bg-purple-50", text: "text-purple-700", badge: "bg-purple-100 text-purple-700" },
              };
              
              const colors = colorConfig[tier.color] || colorConfig.green;
              const ozonTierPricing = calculateOzonBackendPricing(tier.priceRMB, input.exchangeRate);
              
              return (
                <div
                  key={index}
                  className={`min-h-[132px] rounded-lg border p-2.5 ${colors.border} ${colors.bg} ${
                    tier.disabled ? "opacity-50" : ""
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className={`truncate text-sm font-bold ${colors.text}`}>{tier.label}</div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${colors.badge}`}>
                      {tier.profitMargin}%
                    </span>
                  </div>
                  {tier.disabled ? (
                    <div className="flex h-10 items-center rounded-md bg-white/60 px-2 text-xs font-medium text-muted-foreground">
                      {tier.error || "空间不足"}
                    </div>
                  ) : (
                    <>
                      <div className={`text-xl font-black leading-none tabular-nums ${colors.text}`}>
                        ¥{tier.priceRMB.toFixed(2)}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>≈{tier.priceRUB.toLocaleString()} ₽</span>
                        <span className="truncate text-right">{tier.description}</span>
                      </div>
                      {ozonTierPricing.isValid && (
                        <div className="mt-2 rounded-md border border-white/70 bg-white/70 px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2 text-[10px] font-semibold text-slate-600">
                            <span>后台 ¥{ozonTierPricing.ozonBackendPriceRMB.toFixed(2)}</span>
                            <button
                              type="button"
                              onClick={() => onCopyOzonPrice?.(`${tier.label} 后台定价`, ozonTierPricing.ozonBackendPriceRMB.toFixed(2))}
                              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                              title="复制后台定价"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-slate-500">
                            <span>折前 ¥{ozonTierPricing.ozonOriginalPriceRMB.toFixed(2)}</span>
                            <button
                              type="button"
                              onClick={() => onCopyOzonPrice?.(`${tier.label} 折扣前价格`, ozonTierPricing.ozonOriginalPriceRMB.toFixed(2))}
                              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                              title="复制折扣前价格"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            ≈ ₽{ozonTierPricing.ozonBackendPriceRUB.toLocaleString()} / ₽{ozonTierPricing.ozonOriginalPriceRUB.toLocaleString()}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* 利润演练折线图 - X轴RMB售价 */}
          {chartsExpanded && (
          <>
          <div className="h-72 min-h-72 mb-4">
            <h4 className="text-sm font-medium mb-2">利润演练曲线</h4>
            <ResponsiveContainer width="100%" height={240} minWidth={320}>
              <LineChart data={profitCurve}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="priceRMB"
                  tick={{ fontSize: 11 }}
                  label={{ value: "售价 (¥)", position: "insideBottom", offset: -5, fontSize: 11 }}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  label={{ value: "利润 (¥)", angle: -90, position: "insideLeft", fontSize: 11 }}
                />
                <RechartsTooltip
                  formatter={(value, name) => [
                    name === "profit" ? `¥${Number(value).toFixed(2)}` : `${value}%`,
                    name === "profit" ? "利润" : "佣金率",
                  ]}
                  labelFormatter={(label) => {
                    const item = profitCurve.find((p) => p.priceRMB === label);
                    return item ? `¥${label} (≈${Math.ceil(item.priceRUB)} ₽)` : `¥${label}`;
                  }}
                  contentStyle={{ fontSize: 12 }}
                />
                <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                <ReferenceLine
                  x={input.targetPriceRMB}
                  stroke="#3b82f6"
                  strokeDasharray="3 3"
                  label={{ value: "当前", fontSize: 10 }}
                />
                <Line type="monotone" dataKey="profit" stroke="#dc2626" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 汇率抗压测试表 */}
          <div className="mt-4">
            <h4 className="text-sm font-medium mb-2">汇率抗压测试</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between items-center p-2.5 rounded-lg bg-muted/30">
                <span>当前利润</span>
                <span className={`font-medium ${getFinanceTextClass(result.netProfit)}`}>
                  ¥{result.netProfit.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center p-2.5 rounded-lg bg-yellow-50/80 border border-yellow-100">
                <span>汇率下跌 5%</span>
                <span className={`font-medium ${getFinanceTextClass(stressTest.at5PercentDrop)}`}>
                  ¥{stressTest.at5PercentDrop.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center p-2.5 rounded-lg bg-red-50/80 border border-red-100">
                <span>汇率下跌 10%</span>
                <span className={`font-medium ${getFinanceTextClass(stressTest.at10PercentDrop)}`}>
                  ¥{stressTest.at10PercentDrop.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center p-2.5 rounded-lg bg-orange-50 border border-orange-200">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-medium cursor-help">0 利润极值汇率</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <div className="space-y-1">
                        <p className="font-medium text-sm">0 利润极值汇率 / Zero-Profit Exchange Rate</p>
                        <p className="text-xs text-muted-foreground">
                          当汇率跌至此值时，利润将归零。超过此值将开始亏损。
                        </p>
                        <p className="text-xs text-muted-foreground">
                          The exchange rate at which profit becomes zero. Any lower rate will result in a loss.
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <span className="font-bold text-orange-600">
                  {stressTest.zeroProfitRate > 0 ? `1 RUB = ${stressTest.zeroProfitRate.toFixed(4)} RMB` : "已无法保本"}
                </span>
              </div>
              
              {/* 汇率抗压滑块 */}
              <div className="mt-4 pt-3 border-t border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground">手动模拟汇率跌幅</span>
                  <span className="text-xs font-bold text-orange-600">{customDropPercent}%</span>
                </div>
                <Slider
                  value={[customDropPercent]}
                  onValueChange={(value) => setCustomDropPercent(value[0])}
                  max={50}
                  step={1}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>0%</span>
                  <span>25%</span>
                  <span>50%</span>
                </div>
                {customDropPercent > 0 && (
                  <div className={`flex justify-between items-center p-2.5 rounded-lg mt-2 ${getFinancePanelClass(customDropProfit)}`}>
                    <span className="text-xs font-medium">汇率下跌 {customDropPercent}% 后利润</span>
                    <span className={`text-sm font-bold ${getFinanceTextClass(customDropProfit)}`}>
                      ¥{customDropProfit.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
          </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
