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
  lockedChannelId?: string | null;
  onUnlockChannel?: () => void;
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
}

const COST_COLORS = ["#6366F1", "#F59E0B", "#8B5CF6", "#EF4444", "#10B981", "#EC4899"];

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
  lockedChannelId,
  onUnlockChannel,
  profitCurve,
  stressTest,
  multiItemProfit,
  sixTierPricing,
  commission,
}: DashboardProps) {
  const E = input.exchangeRate; // CNY/RUB (1 CNY = X RUB)

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
    ].filter((d) => d.value > 0);
    
    // 🔹 计算总成本验证
    const chartTotal = data.reduce((sum, item) => sum + item.value, 0);
    const costTotal = result.costs.total;
    
    return data;
  }, [result.costs]);

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

  return (
    <div className="space-y-5 overflow-y-auto max-h-[calc(100vh-6rem)] pr-1 scrollbar-thin">
      {/* 警告信息已移至左侧 Live Monitor Console */}



      {/* 🔹 实时调试卡片：佣金阶梯匹配（已隐藏） */}
      {/* 
      <Card className="bg-blue-50 border-2 border-blue-300">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-blue-700" />
            <span className="font-bold text-blue-900">🔍 佣金阶梯匹配调试</span>
          </div>
          
          
          {commission && commission.tiers.length >= 2 && (
            (() => {
              const rates = commission.tiers.map(t => t.rate);
              const allSame = rates.every(r => r === rates[0]);
              if (allSame) {
                return (
                  <div className="mb-3 p-3 bg-red-100 border-2 border-red-400 rounded-md">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-red-700 mt-0.5" />
                      <div className="text-sm text-red-800 font-medium">
                        <div className="font-bold mb-1">⚠️ 佣金数据异常！</div>
                        <div>所有阶梯费率相同 ({rates[0]}%)，可能是数据解析错误。</div>
                        <div className="mt-2 text-xs">请按以下步骤修复：</div>
                        <ol className="list-decimal ml-4 mt-1 text-xs space-y-1">
                          <li>刷新页面（F5）清除缓存</li>
                          <li>重新上传佣金表 CSV 文件</li>
                          <li>检查控制台日志确认阶梯费率</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })()
          )}
          
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-blue-700">前台售价 (RMB):</span>
              <span className="font-bold text-blue-900">{input.targetPriceRMB.toFixed(2)} ¥</span>
            </div>
            <div className="flex justify-between">
              <span className="text-blue-700">使用汇率:</span>
              <span className="font-medium text-blue-800">{input.exchangeRate.toFixed(4)} {input.exchangeRateBuffer > 0 && <span className="text-orange-600">(缓冲后)</span>}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-blue-700">前台售价 (RUB):</span>
              <span className="font-bold text-blue-900">{cnyToRub(input.targetPriceRMB, input.exchangeRate).toFixed(2)} ₽</span>
            </div>
            <div className="flex justify-between">
              <span className="text-blue-700">当前佣金率:</span>
              <span className="font-bold text-blue-900 text-lg">{result.commissionRate}%</span>
            </div>
            {commission && (
              <>
                <div className="flex justify-between">
                  <span className="text-blue-700">所属阶梯:</span>
                  <span className="font-medium text-blue-800">
                    {(() => {
                      const priceRUB = cnyToRub(input.targetPriceRMB, input.exchangeRate);
                      const matchedTier = commission.tiers.find(tier => priceRUB >= tier.min && priceRUB <= tier.max);
                      if (matchedTier) {
                        return `${matchedTier.min}-${matchedTier.max === Infinity ? '∞' : matchedTier.max} RUB`;
                      }
                      return '未知';
                    })()}
                  </span>
                </div>
                <div className="mt-3 pt-2 border-t border-blue-300">
                  <div className="text-xs text-blue-700 mb-1">所有阶梯费率：</div>
                  {commission.tiers.map((tier, i) => {
                    const priceRUB = cnyToRub(input.targetPriceRMB, input.exchangeRate);
                    const isMatched = priceRUB >= tier.min && priceRUB <= tier.max;
                    return (
                      <div key={i} className={`flex justify-between text-xs ${isMatched ? 'font-bold text-blue-900' : 'text-blue-600'}`}>
                        <span>{tier.min}-{tier.max === Infinity ? '∞' : tier.max} RUB</span>
                        <span>{tier.rate}% {isMatched && '✓'}</span>
                      </div>
                    );
                  })}
                </div>
                {input.exchangeRateBuffer > 0 && (
                  <div className="mt-2 pt-2 border-t border-blue-300">
                    <div className="text-xs text-orange-700">
                      ⚠️ 已启用汇率安全缓冲 {input.exchangeRateBuffer}%，实际汇率: {(input.exchangeRate / (1 - input.exchangeRateBuffer / 100)).toFixed(4)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
      */}

      {/* 卡片 1：财务精算与成本结构图 */}
      <Card>
        <CardHeader className="pb-3">
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
        <CardContent>
          {/* 🔹 利润预警提示 */}
          {profitWarningThreshold !== undefined && profitWarningThreshold !== null && result.profitMargin < profitWarningThreshold && (
            <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-300 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
              <div className="text-sm text-amber-800">
                利润率 <span className="font-bold">{result.profitMargin.toFixed(1)}%</span> 低于预警阈值 <span className="font-bold">{profitWarningThreshold}%</span>
              </div>
            </div>
          )}

          {/* 核心 KPI */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="text-center p-4 rounded-xl bg-gradient-to-br from-muted/40 to-muted/10 border">
              <div className="text-xs text-muted-foreground mb-1">单件净利润</div>
              <div className={`text-2xl font-bold ${isProfit ? "text-green-600" : "text-red-600"}`}>
                ¥{result.netProfit.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {E > 0 ? `≈${(result.netProfit * E).toFixed(0)} ₽` : ""}
              </div>
            </div>
            <div className="text-center p-4 rounded-xl bg-gradient-to-br from-muted/40 to-muted/10 border">
              <div className="text-xs text-muted-foreground mb-1">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help">投资回报率 ROI</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3">
                      <div className="space-y-1">
                        <p className="font-medium text-sm">投资回报率 / Return on Investment</p>
                        <p className="text-xs text-slate-600">
                          每投入1元总成本能赚取多少净利润。ROI 越高，盈利能力越强。
                        </p>
                        <p className="text-xs text-slate-600">
                          计算公式：净利润 ÷ 总成本 × 100%
                        </p>
                        <p className="text-[10px] text-slate-400 mt-1">
                          总成本 = 采购 + 头程 + 包装 + 跨境运费 + 佣金 + 提现手续费 + 广告 + 退货损耗
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className={`text-2xl font-bold ${result.roi >= 0 ? "text-green-600" : "text-red-600"}`}>
                {result.roi.toFixed(1)}%
              </div>
            </div>
            <div className="text-center p-4 rounded-xl bg-gradient-to-br from-muted/40 to-muted/10 border">
              <div className="text-xs text-muted-foreground mb-1">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help">销售利润率</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3">
                      <div className="space-y-1">
                        <p className="font-medium text-sm">销售利润率 / Profit Margin</p>
                        <p className="text-xs text-slate-600">
                          每卖出1元能赚多少净利润。利润率越高，产品定价空间越大。
                        </p>
                        <p className="text-xs text-slate-600">
                          计算公式：(售价 - 总成本) ÷ 售价 × 100%
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className={`text-2xl font-bold ${result.profitMargin >= 0 ? "text-green-600" : "text-red-600"}`}>
                {result.profitMargin.toFixed(1)}%
              </div>
            </div>
          </div>

          {/* 🔹 竞品价格对比 */}
          {rivalPrice && rivalPrice > 0 && input.targetPriceRMB > 0 ? (
            <div className="text-center p-4 rounded-xl bg-gradient-to-br from-muted/40 to-muted/10 border">
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
                    <div className={`text-2xl font-bold ${isHigher ? "text-green-600" : "text-red-600"}`}>
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

          {/* 成本结构环形图 - 外围百分比常显 */}
          <div className="min-h-64 flex items-center">
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
        </CardContent>
      </Card>

      {/* 卡片 2：六档定价推荐矩阵 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">六档定价推荐矩阵</CardTitle>
        </CardHeader>
        <CardContent>
          {/* 六档定价推荐网格 - 3列 x 2行 */}
          <div className="grid grid-cols-3 gap-3 mb-6">
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
              
              return (
                <div
                  key={index}
                  className={`p-3 rounded-xl border-2 ${colors.border} ${colors.bg} shadow-sm transition-all hover:shadow-md ${
                    tier.disabled ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className={`text-xs font-medium ${colors.text}`}>{tier.label}</div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${colors.badge}`}>
                      {tier.profitMargin}%
                    </span>
                  </div>
                  {tier.disabled ? (
                    <div className="text-sm font-medium text-muted-foreground mt-1">
                      {tier.error || "空间不足"}
                    </div>
                  ) : (
                    <>
                      <div className={`text-lg font-bold ${colors.text} mt-1`}>
                        ¥{tier.priceRMB.toFixed(2)}
                      </div>
                      <div className={`text-xs text-slate-500 mt-0.5`}>
                        ≈{tier.priceRUB.toLocaleString()} ₽
                      </div>
                    </>
                  )}
                  <div className="text-[10px] text-muted-foreground mt-1">
                    {tier.description}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 利润演练折线图 - X轴RMB售价 */}
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
                <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="3 3" />
                <ReferenceLine
                  x={input.targetPriceRMB}
                  stroke="#3b82f6"
                  strokeDasharray="3 3"
                  label={{ value: "当前", fontSize: 10 }}
                />
                <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 汇率抗压测试表 */}
          <div className="mt-4">
            <h4 className="text-sm font-medium mb-2">汇率抗压测试</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between items-center p-2.5 rounded-lg bg-muted/30">
                <span>当前利润</span>
                <span className={`font-medium ${result.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                  ¥{result.netProfit.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center p-2.5 rounded-lg bg-yellow-50/80 border border-yellow-100">
                <span>汇率下跌 5%</span>
                <span className={`font-medium ${stressTest.at5PercentDrop >= 0 ? "text-green-600" : "text-red-600"}`}>
                  ¥{stressTest.at5PercentDrop.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center p-2.5 rounded-lg bg-red-50/80 border border-red-100">
                <span>汇率下跌 10%</span>
                <span className={`font-medium ${stressTest.at10PercentDrop >= 0 ? "text-green-600" : "text-red-600"}`}>
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
                  <div className={`flex justify-between items-center p-2.5 rounded-lg mt-2 ${
                    customDropProfit >= 0 ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"
                  }`}>
                    <span className="text-xs font-medium">汇率下跌 {customDropPercent}% 后利润</span>
                    <span className={`text-sm font-bold ${customDropProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                      ¥{customDropProfit.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
