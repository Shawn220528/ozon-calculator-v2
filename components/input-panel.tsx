"use client";

import { useState, useMemo, useEffect, useRef, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Package, Truck, Megaphone, Tag, AlertTriangle, RotateCcw, Battery, Droplets, CheckCircle2, DollarSign, Lock, Unlock, ChevronDown, Copy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useDataHub } from "@/lib/data-hub-context";
import { CalculationInput, ShippingChannel } from "@/lib/types";
import { calculateOzonBackendPricing } from "@/lib/ozon-pricing";
import { isProfitMarginBelowThreshold } from "@/lib/profit-threshold";

/**
 * 🔹 全局汇率转换准则 (Exchange Rate Conversion Rules)
 * ========================================================
 * 定义: exchangeRate = 1 人民币可以兑换多少卢布 (例如: 12.0)
 * 
 * 方向 A: 人民币 ➔ 卢布 (CNY → RUB): val * exchangeRate
 * 方向 B: 卢布 ➔ 人民币 (RUB → CNY): val / exchangeRate
 * 
 * 禁止: 任何反向逻辑 (如 val / exchangeRate 用于 CNY→RUB)
 * ========================================================
 */

// 🔹 计费信息类型（用于计抛预警同步）
interface BillingInfo {
  mode: string;
  billingWeight: number;
  actualWeight: number;
  volumetricWeight: number;
  isVolumetric: boolean;
  divisor: number;
}

interface InputPanelProps {
  input: CalculationInput;
  onInputChange: (input: CalculationInput) => void;
  // 🔹 竞品价格（用于对比显示）- 简化为单个值
  rivalPrice?: number;
  rivalCurrency?: 'RMB' | 'RUB';
  // 逆向推价所需的额外参数
  currentProfitMargin?: number; // 当前实际利润率 (%)
  onReversePriceFromMargin?: (targetMargin: number) => void; // 逆向推价回调
  marginError?: string | null; // 利润率熔断警告
  onReset?: () => void; // 一键重置回调
  // 广告风控数据
  adRiskControl?: {
    breakEvenACOS: number;
    currentACOS: number;
    isOverBudget: boolean;
    cvrSensitivity?: {
      costReduction: number;
      profitIncreasePercent: number;
      currentCost: number;
      newCost: number;
    };
  };
  // 🔹 物流数据（用于检测功能依赖）
  shippingData?: ShippingChannel[];
  // 🔹 选中物流渠道计费信息（用于计抛预警同步）
  selectedBillingInfo?: BillingInfo | null;
  // 🔹 利润率锁定：null=未锁定, 数字=锁定的利润率值(%)
  lockedMargin?: number | null;
  onToggleMarginLock?: () => void;
  // 🔹 智能售价建议
  suggestedPriceInfo?: {
    suggestedPriceRMB: number;
    suggestedPriceRUB: number;
    channelName: string;
    fixableChannels: Array<{
      channelName: string;
      minValueRUB: number;
      minPriceRMB: number;
      suggestedPriceRMB?: number;
      profitPriceRMB?: number;
      logisticsPriceRMB?: number;
      reason?: "profit-target" | "logistics-threshold";
    }>;
    unfixableChannelCount: number;
    cannotFixByPrice: boolean;
    reason?: "profit-target" | "logistics-threshold" | "none";
    targetMargin?: number | null;
    profitPriceRMB?: number;
    logisticsPriceRMB?: number;
  } | null;
  onCopyOzonPrice?: (label: string, value: string) => void;
}

type CategorySearchLevel = "一级" | "二级" | "三级";

interface CategorySearchResult {
  id: string;
  level: CategorySearchLevel;
  matchedLevel: CategorySearchLevel;
  matchedLabel: string;
  primary: string;
  secondary: string;
  tertiary: string;
  pathLabel: string;
}

function normalizeCategorySearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function numberInputValue(value: number | null | undefined): number | "" {
  return value === null || value === undefined || Number.isNaN(value) ? "" : value;
}

function optionalNumberInputValue(value: string): number | null {
  if (value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function Section({
  id,
  title,
  summary,
  icon,
  defaultOpen = true,
  openSections,
  setOpenSections,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  icon: ReactNode;
  defaultOpen?: boolean;
  openSections: Record<string, boolean>;
  setOpenSections: Dispatch<SetStateAction<Record<string, boolean>>>;
  children: ReactNode;
}) {
  return (
    <details
      open={openSections[id] ?? defaultOpen}
      className="group rounded-lg border bg-card text-card-foreground shadow-none"
      onToggle={(event) => {
        const isOpen = event.currentTarget.open;
        setOpenSections((current) => current[id] === isOpen ? current : { ...current, [id]: isOpen });
      }}
    >
      <summary className="flex h-9 cursor-pointer list-none items-center justify-between gap-2 px-2.5 text-sm font-semibold">
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="shrink-0">{title}</span>
          <span className="truncate text-[11px] font-medium text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-slate-100 p-2.5">{children}</div>
    </details>
  );
}

export function InputPanel({ input, onInputChange, rivalPrice, rivalCurrency = 'RMB', currentProfitMargin, onReversePriceFromMargin, marginError, onReset, adRiskControl, shippingData = [], selectedBillingInfo, lockedMargin = null, onToggleMarginLock, suggestedPriceInfo, onCopyOzonPrice }: InputPanelProps) {
  const { getCategories } = useDataHub();
  const categories = useMemo(() => getCategories(), [getCategories]);
  const [categorySearch, setCategorySearch] = useState("");
  const [categorySearchFocused, setCategorySearchFocused] = useState(false);
  const categorySearchInputRef = useRef<HTMLInputElement>(null);
  
  // 🔹 检测物流表功能依赖
  const hasBatteryMapping = useMemo(() => {
    return shippingData.some(channel => channel.batteryAllowed !== false);
  }, [shippingData]);
  
  const hasLiquidMapping = useMemo(() => {
    return shippingData.some(channel => channel.liquidAllowed !== false);
  }, [shippingData]);
  
  // 目标利润率输入状态（用于逆向推价）
  const [targetMarginInput, setTargetMarginInput] = useState<string>("");
  
  // 🔹 输入源标记：防止循环更新
  const isUpdatingFromMargin = useRef(false);
  
  // 🔹 初始化：组件加载时显示当前利润率
  useEffect(() => {
    if (currentProfitMargin !== undefined && targetMarginInput === "") {
      setTargetMarginInput(currentProfitMargin.toFixed(1));
    }
  }, []); // 仅在组件挂载时执行
  
  // 🔹 当售价变化时，自动同步利润率显示
  useEffect(() => {
    // 如果当前正在从利润率反推售价，跳过此次同步
    if (isUpdatingFromMargin.current) {
      isUpdatingFromMargin.current = false;
      return;
    }
    
    // 🔹 利润率锁定时，不同步外部利润率到输入框（保持锁定值不变）
    if (lockedMargin !== null) return;
    
    // 当实际利润率变化且不是用户手动输入利润率时，自动同步到输入框
    if (currentProfitMargin !== undefined) {
      setTargetMarginInput(currentProfitMargin.toFixed(1));
    }
  }, [currentProfitMargin, lockedMargin]);
  
  // 🔹 计抛预警逻辑
  // 仅当：1) 选中的渠道支持计抛 2) 计费重 > 实重 时显示
  const isVolumetricWarning = selectedBillingInfo?.isVolumetric === true;
  const volWarningActive = isVolumetricWarning && (selectedBillingInfo?.billingWeight || 0) > (selectedBillingInfo?.actualWeight || 0);
  const billingWeight = selectedBillingInfo?.billingWeight || 0;
  const actualWeight = selectedBillingInfo?.actualWeight || input.weight;
  const volumetricWeight = selectedBillingInfo?.volumetricWeight || 0;
  const divisor = selectedBillingInfo?.divisor ?? 12000;

  const updateField = <K extends keyof CalculationInput>(key: K, value: CalculationInput[K]) => {
    onInputChange({ ...input, [key]: value });
  };

  const handlePrimaryCategoryChange = (primary: string) => {
    const cat = categories.find((c) => c.primary === primary);
    const secondary = cat?.secondary[0]?.name || "";
    const tertiary = cat?.secondary[0]?.tertiary[0] || "";
    onInputChange({ ...input, primaryCategory: primary, secondaryCategory: secondary, tertiaryCategory: tertiary });
  };

  const selectedCategory = categories.find((c) => c.primary === input.primaryCategory);
  const selectedSecondaryCategory = selectedCategory?.secondary.find((sec) => sec.name === input.secondaryCategory);
  const showTertiaryCategory = (selectedSecondaryCategory?.tertiary.length || 0) > 0;
  const handleSecondaryCategoryChange = (secondary: string) => {
    const sec = selectedCategory?.secondary.find((item) => item.name === secondary);
    onInputChange({ ...input, secondaryCategory: secondary, tertiaryCategory: sec?.tertiary[0] || "" });
  };

  const categorySearchResults = useMemo<CategorySearchResult[]>(() => {
    const query = normalizeCategorySearchText(categorySearch.trim());
    if (!query) return [];

    const results: CategorySearchResult[] = [];
    const pushResult = (result: CategorySearchResult) => {
      if (results.length < 20) results.push(result);
    };

    categories.forEach((cat) => {
      if (normalizeCategorySearchText(cat.primary).includes(query)) {
        const firstSecondary = cat.secondary[0];
        pushResult({
          id: `primary:${cat.primary}`,
          level: "一级",
          matchedLevel: "一级",
          matchedLabel: cat.primary,
          primary: cat.primary,
          secondary: firstSecondary?.name || "",
          tertiary: firstSecondary?.tertiary[0] || "",
          pathLabel: cat.primary,
        });
      }

      cat.secondary.forEach((sec) => {
        if (normalizeCategorySearchText(sec.name).includes(query)) {
          pushResult({
            id: `secondary:${cat.primary}:${sec.name}`,
            level: "二级",
            matchedLevel: "二级",
            matchedLabel: sec.name,
            primary: cat.primary,
            secondary: sec.name,
            tertiary: sec.tertiary[0] || "",
            pathLabel: `${cat.primary} > ${sec.name}`,
          });
        }

        sec.tertiary.forEach((ter) => {
          if (normalizeCategorySearchText(ter).includes(query)) {
            pushResult({
              id: `tertiary:${cat.primary}:${sec.name}:${ter}`,
              level: "三级",
              matchedLevel: "三级",
              matchedLabel: ter,
              primary: cat.primary,
              secondary: sec.name,
              tertiary: ter,
              pathLabel: `${cat.primary} > ${sec.name} > ${ter}`,
            });
          }
        });
      });
    });

    return results;
  }, [categories, categorySearch]);

  const showCategorySearchResults = categorySearchFocused && categorySearch.trim().length > 0;

  const handleCategorySearchSelect = (result: CategorySearchResult) => {
    onInputChange({
      ...input,
      primaryCategory: result.primary,
      secondaryCategory: result.secondary,
      tertiaryCategory: result.tertiary,
    });
    setCategorySearch("");
    setCategorySearchFocused(true);
    window.setTimeout(() => {
      categorySearchInputRef.current?.focus();
    }, 0);
  };

  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return { product: true, cost: true, ads: true, pricing: true };
    try {
      const saved = localStorage.getItem("input-panel-sections");
      return saved ? JSON.parse(saved) : { product: true, cost: true, ads: true, pricing: true };
    } catch {
      return { product: true, cost: true, ads: true, pricing: true };
    }
  });

  // 🔹 持久化折叠状态
  useEffect(() => {
    localStorage.setItem("input-panel-sections", JSON.stringify(openSections));
  }, [openSections]);

  const ozonPricing = useMemo(
    () => calculateOzonBackendPricing(input.targetPriceRMB, input.exchangeRate),
    [input.targetPriceRMB, input.exchangeRate]
  );
  const cpcBillingMode = input.cpcBillingMode || "bidCvr";
  const cpcSalesCostRMB = input.targetPriceRMB > 0 ? input.targetPriceRMB * ((input.cpcSalesPercent || 0) / 100) : 0;
  const cpcBidCostRUB = input.cpcConversionRate > 0 ? input.cpcBid / (input.cpcConversionRate / 100) : 0;
  const cpcBidCostRMB = input.exchangeRate > 0 ? cpcBidCostRUB / input.exchangeRate : 0;

  return (
    <div className="space-y-2 pr-1">

      {/* 模块 A：商品参数与物流拦截 */}
      <Section
        id="product"
        title="商品属性"
        summary={`${input.length}×${input.width}×${input.height}cm / ${input.weight}g`}
        icon={<Package className="h-4 w-4" />}
        openSections={openSections}
        setOpenSections={setOpenSections}
        defaultOpen
      >
        <div className="space-y-2">
          <div className="relative space-y-1.5">
            <Label className="text-xs">类目搜索</Label>
            <Input
              ref={categorySearchInputRef}
              type="text"
              value={categorySearch}
              onChange={(event) => {
                setCategorySearch(event.target.value);
                setCategorySearchFocused(true);
              }}
              onFocus={() => setCategorySearchFocused(true)}
              onBlur={() => setCategorySearchFocused(false)}
              className="h-8 text-sm"
              placeholder="搜索一级 / 二级 / 三级类目"
              autoComplete="off"
            />
            {showCategorySearchResults && (
              <div className="absolute left-0 top-full z-[60] mt-1 max-h-80 w-[min(42rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
                {categorySearchResults.length > 0 ? (
                  <div className="space-y-1">
                    {categorySearchResults.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          handleCategorySearchSelect(result);
                        }}
                        className="flex w-full items-start gap-2 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-indigo-50 focus:bg-indigo-50 focus:outline-none"
                      >
                        <span className="mt-0.5 shrink-0 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                          {result.level}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block whitespace-normal break-words text-xs font-bold leading-snug text-slate-800">
                            {result.matchedLabel}
                          </span>
                          <span className="mt-1 block whitespace-normal break-words text-[10px] leading-snug text-slate-500">
                            {result.pathLabel}
                          </span>
                          <span className="mt-1 block text-[10px] text-indigo-500">命中{result.matchedLevel}类目，点击代入完整路径</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 py-3 text-center text-xs text-slate-500">未找到匹配类目</div>
                )}
              </div>
            )}
          </div>

          <div className={`grid gap-2 ${showTertiaryCategory ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-2"}`}>
            <div className={`space-y-1.5 ${showTertiaryCategory ? "xl:col-span-1" : ""}`}>
              <Label className="text-xs">一级类目</Label>
              <Select value={input.primaryCategory} onValueChange={handlePrimaryCategoryChange}>
                <SelectTrigger className="h-auto min-h-8 items-start py-1.5 text-left text-sm [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-words [&>span]:leading-snug">
                  <SelectValue placeholder="选择一级类目" />
                </SelectTrigger>
                <SelectContent className="w-[min(28rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
                  {categories.map((cat) => (
                    <SelectItem key={cat.primary} value={cat.primary} className="whitespace-normal break-words leading-snug">
                      {cat.primary}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={`space-y-1.5 ${showTertiaryCategory ? "xl:col-span-1" : ""}`}>
              <Label className="text-xs">二级类目</Label>
              <Select
                value={input.secondaryCategory}
                onValueChange={handleSecondaryCategoryChange}
              >
                <SelectTrigger className="h-auto min-h-8 items-start py-1.5 text-left text-sm [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-words [&>span]:leading-snug">
                  <SelectValue placeholder="选择二级类目" />
                </SelectTrigger>
                <SelectContent className="w-[min(38rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
                  {selectedCategory?.secondary.map((sec) => (
                    <SelectItem key={sec.name} value={sec.name} className="whitespace-normal break-words leading-snug">
                      {sec.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {showTertiaryCategory && (
              <div className="space-y-1.5 xl:col-span-2">
                <Label className="text-xs">三级类目</Label>
                <Select
                  value={input.tertiaryCategory || selectedSecondaryCategory?.tertiary[0] || ""}
                  onValueChange={(v) => updateField("tertiaryCategory", v)}
                >
                  <SelectTrigger className="h-auto min-h-8 items-start py-1.5 text-left text-sm [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-words [&>span]:leading-snug">
                    <SelectValue placeholder="选择三级类目" />
                  </SelectTrigger>
                  <SelectContent className="w-[min(42rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
                    {selectedSecondaryCategory?.tertiary.map((ter) => (
                      <SelectItem key={ter} value={ter} className="whitespace-normal break-words leading-snug">
                        {ter}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">长 (cm)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={input.length || input.length === 0 ? input.length : ""}
                onChange={(e) => updateField("length", parseFloat(e.target.value) || 0)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">宽 (cm)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={input.width || input.width === 0 ? input.width : ""}
                onChange={(e) => updateField("width", parseFloat(e.target.value) || 0)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">高 (cm)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={input.height || input.height === 0 ? input.height : ""}
                onChange={(e) => updateField("height", parseFloat(e.target.value) || 0)}
                className="h-8 text-sm"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">实际物理重量 (g)</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={input.weight || input.weight === 0 ? input.weight : ""}
              onChange={(e) => updateField("weight", parseFloat(e.target.value) || 0)}
              className="h-8 text-sm"
            />
            {/* 🔹 计抛预警：仅在 isVolumetric && billingWeight > actualWeight 时显示 - 强烈橙色 */}
            {volWarningActive && selectedBillingInfo && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="text-xs font-bold text-amber-800">
                    ⚠️ 计抛预警
                  </div>
                  <div className="text-xs text-amber-700 mt-1">
                    <div>抛重 <span className="font-bold bg-amber-200 px-1.5 rounded">{selectedBillingInfo.volumetricWeight.toFixed(0)}g</span> &gt; 实重 <span className="font-bold bg-amber-200 px-1.5 rounded">{selectedBillingInfo.actualWeight.toFixed(0)}g</span></div>
                    <div className="mt-1">计费重: <span className="font-bold">{selectedBillingInfo.billingWeight.toFixed(0)}g</span></div>
                  </div>
                  <div className="text-[10px] text-amber-600 mt-1.5 font-mono bg-amber-50 p-1 rounded">
                    {input.length}×{input.width}×{input.height} / {divisor} × 1000 = {selectedBillingInfo.volumetricWeight.toFixed(0)}g
                  </div>
                </div>
              </div>
            )}
            {/* 非泡货时的静默提示 - 仅当有选中渠道且重量>0时显示 */}
            {!volWarningActive && input.weight > 0 && selectedBillingInfo && (
              <div className="text-[10px] text-slate-400">
                抛重 <span className="font-medium">{selectedBillingInfo.volumetricWeight.toFixed(0)}g</span> ≤ 实重 <span className="font-medium">{selectedBillingInfo.actualWeight.toFixed(0)}g</span>，按实重计费
              </div>
            )}
            {/* 未选中渠道时的默认提示 */}
            {!selectedBillingInfo && input.weight > 0 && (
              <div className="text-[10px] text-slate-400">
                抛重 <span className="font-medium">{(input.length * input.width * input.height / 12000 * 1000).toFixed(0)}g</span> ≤ 实重 <span className="font-medium">{input.weight}g</span>
              </div>
            )}
          </div>
          
          {/* 🔹 商品属性开关 - 微型图标按钮组 */}
          <div className="flex gap-2 pt-1">
            {/* 带电按钮 - 微型 */}
            <button
              onClick={() => updateField("hasBattery", !input.hasBattery)}
              className={`flex items-center gap-1 px-2 py-1.5 rounded border text-xs font-medium transition-all h-7 ${
                input.hasBattery 
                  ? "bg-orange-100 border-orange-400 text-orange-700" 
                  : "bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100"
              }`}
            >
              <span>{input.hasBattery ? "⚡" : "🚫"}</span>
              <span>{input.hasBattery ? "带电" : "不带电"}</span>
            </button>
            
            {/* 带液按钮 - 微型 */}
            <button
              onClick={() => updateField("hasLiquid", !input.hasLiquid)}
              className={`flex items-center gap-1 px-2 py-1.5 rounded border text-xs font-medium transition-all h-7 ${
                input.hasLiquid 
                  ? "bg-blue-100 border-blue-400 text-blue-700" 
                  : "bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100"
              }`}
            >
              <span>{input.hasLiquid ? "💧" : "🚫"}</span>
              <span>{input.hasLiquid ? "带液" : "不带液"}</span>
            </button>
          </div>
        </div>
      </Section>

      {/* 模块 B：采购与退货成本 */}
      <Section
        id="cost"
        title="采购成本"
        summary={`采购 ¥${input.purchaseCost || 0} / 头程 ¥${input.domesticShipping || 0} / 退货 ${input.returnRate || 0}%`}
        icon={<DollarSign className="h-4 w-4" />}
        openSections={openSections}
        setOpenSections={setOpenSections}
        defaultOpen
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">采购成本 (¥)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={numberInputValue(input.purchaseCost)}
                onChange={(e) => updateField("purchaseCost", parseFloat(e.target.value) || 0)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">国内头程 (¥)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={numberInputValue(input.domesticShipping)}
                onChange={(e) => updateField("domesticShipping", parseFloat(e.target.value) || 0)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">包装杂费 (¥)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={numberInputValue(input.packagingFee)}
                onChange={(e) => updateField("packagingFee", parseFloat(e.target.value) || 0)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">多件装数量</Label>
              <Input
                type="number"
                min="1"
                max="100"
                step="1"
                value={input.multiItemCount || 1}
                onChange={(e) => updateField("multiItemCount", Math.max(1, parseInt(e.target.value) || 1))}
                className="h-8 text-sm"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium">退货损耗沙盘</Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">预期退货率</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={numberInputValue(input.returnRate)}
                  onChange={(e) => updateField("returnRate", parseFloat(e.target.value) || 0)}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">退货处理方式</Label>
                <Select
                  value={input.returnHandling}
                  onValueChange={(v) => updateField("returnHandling", v as CalculationInput["returnHandling"])}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="destroy">全部销毁 (损货值+运费)</SelectItem>
                    <SelectItem value="resell">退回重售 (仅损运费)</SelectItem>
                    <SelectItem value="productOnly">仅损商品成本</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* 模块 C：广告推广 */}
      <Section
        id="ads"
        title="广告推广"
        summary={`CPA${input.cpaEnabled ? "开" : "关"} / CPC${input.cpcEnabled ? "开" : "关"}`}
        icon={<Megaphone className="h-4 w-4" />}
        openSections={openSections}
        setOpenSections={setOpenSections}
        defaultOpen
      >
        <div className="space-y-2">
          {/* CPA */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">按订单推广 (CPA)</Label>
              <button
                type="button"
                onClick={() => updateField("cpaEnabled", !input.cpaEnabled)}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all focus:outline-none focus:ring-2 focus:ring-blue-300 focus:ring-offset-1 ${
                  input.cpaEnabled
                    ? "bg-green-500 text-white shadow-sm"
                    : "bg-slate-200 text-slate-500"
                }`}
                aria-label={input.cpaEnabled ? "关闭CPA广告" : "开启CPA广告"}
              >
                {input.cpaEnabled ? "ON" : "OFF"}
              </button>
            </div>
            <div className={`transition-opacity ${input.cpaEnabled ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={numberInputValue(input.cpaRate)}
                  onChange={(e) => updateField("cpaRate", parseFloat(e.target.value) || 0)}
                  className="w-20 h-8 text-sm"
                  disabled={!input.cpaEnabled}
                />
                <span className="text-xs text-muted-foreground">%</span>
                {input.cpaEnabled && input.cpaRate > 0 && (
                  <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">
                    广告费: {input.cpaRate}%×售价
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* CPC */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">按点击推广 (CPC)</Label>
              <button
                type="button"
                onClick={() => updateField("cpcEnabled", !input.cpcEnabled)}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all focus:outline-none focus:ring-2 focus:ring-blue-300 focus:ring-offset-1 ${
                  input.cpcEnabled
                    ? "bg-blue-600 text-white shadow-sm"
                    : "bg-slate-200 text-slate-500"
                }`}
                aria-label={input.cpcEnabled ? "关闭CPC广告" : "开启CPC广告"}
              >
                {input.cpcEnabled ? "ON" : "OFF"}
              </button>
            </div>
            <div className={`transition-opacity ${input.cpcEnabled ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
              <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => updateField("cpcBillingMode", "bidCvr")}
                  disabled={!input.cpcEnabled}
                  className={`h-7 rounded text-xs font-medium transition-colors ${
                    cpcBillingMode === "bidCvr"
                      ? "bg-white text-blue-700 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  竞价/CVR
                </button>
                <button
                  type="button"
                  onClick={() => updateField("cpcBillingMode", "salesPercent")}
                  disabled={!input.cpcEnabled}
                  className={`h-7 rounded text-xs font-medium transition-colors ${
                    cpcBillingMode === "salesPercent"
                      ? "bg-white text-blue-700 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  销售额比例
                </button>
              </div>

              {cpcBillingMode === "salesPercent" ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">销售额目标占比</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={numberInputValue(input.cpcSalesPercent)}
                      onChange={(e) => updateField("cpcSalesPercent", parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                      disabled={!input.cpcEnabled}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">单次竞价 (₽)</Label>
                    <div className="relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">₽</span>
                      <Input
                        type="number"
                        min="0"
                        step="0.1"
                        value={numberInputValue(input.cpcBid)}
                        onChange={(e) => updateField("cpcBid", parseFloat(e.target.value) || 0)}
                        className="h-8 text-sm pl-6"
                        disabled={!input.cpcEnabled}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">转化率 CVR</Label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={numberInputValue(input.cpcConversionRate)}
                      onChange={(e) => updateField("cpcConversionRate", parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                      disabled={!input.cpcEnabled}
                    />
                  </div>
                </div>
              )}
              {input.cpcEnabled && cpcBillingMode === "bidCvr" && input.cpcBid > 0 && input.cpcConversionRate > 0 && (
                <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded mt-1 flex items-center gap-1">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help font-medium">单均转化成本</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={8} className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3">
                        <div className="space-y-1">
                          <p className="font-medium text-sm">单均转化成本 / Cost Per Conversion</p>
                          <p className="text-xs text-slate-600">
                            每获得一个订单所需的广告花费（卢布）。计算公式：单次竞价(₽) ÷ 转化率，再折算为人民币
                          </p>
                          <p className="text-xs text-slate-600">
                            The advertising cost per order (in RUB). Formula: CPC Bid(₽) ÷ Conversion Rate, then convert to CNY
                          </p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <span>: ₽{cpcBidCostRUB.toFixed(2)} (≈¥{cpcBidCostRMB.toFixed(2)})</span>
                </div>
              )}
              {input.cpcEnabled && cpcBillingMode === "salesPercent" && input.cpcSalesPercent > 0 && (
                <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded mt-1 flex flex-wrap items-center gap-1">
                  <span className="font-medium">单均广告成本</span>
                  <span>: ¥{cpcSalesCostRMB.toFixed(2)}</span>
                  <span className="text-blue-500">ACOS {input.cpcSalesPercent.toFixed(1)}%</span>
                </div>
              )}
            </div>
          </div>
          
          {/* 广告风控面板 */}
          {adRiskControl && (input.cpaEnabled || input.cpcEnabled) && (
            <div className="mt-3 pt-3 border-t border-slate-200 space-y-2">
              {/* 保本 ACOS 显示 */}
              <div className="flex items-center justify-between text-xs">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-muted-foreground cursor-help">保本 ACOS:</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3">
                      <div className="space-y-1">
                        <p className="font-medium text-sm">保本 ACOS / Break-Even ACOS</p>
                        <p className="text-xs text-slate-600">
                          广告支出占销售额的最高安全比例。当 ACOS ≤ 保本 ACOS 时，广告花费可控；超过则每单亏损。
                        </p>
                        <p className="text-xs text-slate-600">
                          计算公式：(售价 - 总成本 + 广告费) ÷ 售价 × 100%
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <span className="font-medium">{adRiskControl.breakEvenACOS.toFixed(1)}%</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={`text-muted-foreground cursor-help`}>当前 ACOS:</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3">
                      <div className="space-y-1">
                        <p className="font-medium text-sm">当前 ACOS / Current ACOS</p>
                        <p className="text-xs text-slate-600">
                          实际广告支出占销售额的比例。ACOS 越低，广告效率越高。
                        </p>
                        <p className="text-xs text-slate-600">
                          计算公式：单均广告成本 ÷ 售价 × 100%
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <span className={`font-medium ${adRiskControl.isOverBudget ? 'text-red-600' : ''}`}>
                  {adRiskControl.currentACOS.toFixed(1)}%
                </span>
              </div>
              
              {/* 超预算警告 */}
              {adRiskControl.isOverBudget && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-2 rounded animate-pulse flex items-start gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span className="font-medium">当前 ACOS 已超过保本 ACOS，需降广告或提售价。</span>
                </div>
              )}
              
              {/* CVR 灵敏度提示 */}
              {input.cpcEnabled && cpcBillingMode === "bidCvr" && adRiskControl.cvrSensitivity && adRiskControl.cvrSensitivity.costReduction > 0 && (
                <div className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-2 rounded">
                  💡 提示：若转化率 (CVR) 提升 1%，单均转化成本将下降 ¥{adRiskControl.cvrSensitivity.costReduction.toFixed(2)}
                  {adRiskControl.cvrSensitivity.profitIncreasePercent > 0 && (
                    <span>，净利润提升 {adRiskControl.cvrSensitivity.profitIncreasePercent.toFixed(1)}%</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* 模块 D：定价与税务 */}
      <Section
        id="pricing"
        title="定价税务"
        summary={`售价 ¥${input.targetPriceRMB || 0} / 支付 ${input.paymentFee || 0}% / 税金${input.taxEnabled ? "开" : "关"}`}
        icon={<Tag className="h-4 w-4" />}
        openSections={openSections}
        setOpenSections={setOpenSections}
        defaultOpen
      >
        <div className="space-y-2">
          {/* 双向售价输入组：RMB / RUB */}
          <div className="grid grid-cols-2 gap-2">
            {/* RMB 售价 */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">前台售价 (RMB)</Label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">¥</span>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={numberInputValue(input.targetPriceRMB)}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "" || val === "-") {
                      updateField("targetPriceRMB", 0);
                    } else {
                      updateField("targetPriceRMB", parseFloat(val) || 0);
                    }
                  }}
                  className="h-8 text-sm pl-6"
                  placeholder="0"
                />
              </div>
            </div>
            {/* RUB 售价 */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">前台售价 (RUB)</Label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">₽</span>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={
                    input.targetPriceRMB > 0 && input.exchangeRate > 0
                      ? parseFloat((input.targetPriceRMB * input.exchangeRate).toFixed(2))
                      : ""
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "" || val === "-") {
                      updateField("targetPriceRMB", 0);
                    } else {
                      const rubValue = parseFloat(val) || 0;
                      const rmbValue = rubValue / input.exchangeRate;
                      updateField("targetPriceRMB", parseFloat(rmbValue.toFixed(4)));
                    }
                  }}
                  className="h-8 text-sm pl-6"
                  placeholder="0"
                />
              </div>
            </div>
          </div>

          {suggestedPriceInfo && suggestedPriceInfo.suggestedPriceRMB > 0 && input.targetPriceRMB <= 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-amber-800">建议填入前台售价</div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-lg font-black tabular-nums text-amber-700">
                      ¥{suggestedPriceInfo.suggestedPriceRMB}
                    </span>
                    <span className="text-[11px] font-medium text-amber-700">
                      ≈ ₽{Math.round(suggestedPriceInfo.suggestedPriceRUB).toLocaleString()}
                    </span>
                    <span className="text-[11px] text-slate-600">
                      匹配「{suggestedPriceInfo.channelName}」
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onInputChange({ ...input, targetPriceRMB: suggestedPriceInfo.suggestedPriceRMB })}
                  className="h-8 shrink-0 rounded-md bg-amber-500 px-3 text-xs font-bold text-white transition-colors hover:bg-amber-600"
                >
                  填入
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-slate-600">
                {suggestedPriceInfo.targetMargin ? (
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-amber-700">
                    按 {suggestedPriceInfo.targetMargin}% 目标利润率计算
                  </span>
                ) : (
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-amber-700">
                    佣金缺失，按物流门槛价计算
                  </span>
                )}
                {suggestedPriceInfo.logisticsPriceRMB !== undefined && suggestedPriceInfo.logisticsPriceRMB > 0 && (
                  <span className="rounded bg-white/70 px-1.5 py-0.5">
                    物流门槛 ¥{Math.ceil(suggestedPriceInfo.logisticsPriceRMB)}
                  </span>
                )}
                {suggestedPriceInfo.profitPriceRMB !== undefined && suggestedPriceInfo.profitPriceRMB > 0 && (
                  <span className="rounded bg-white/70 px-1.5 py-0.5">
                    利润目标 ¥{Math.ceil(suggestedPriceInfo.profitPriceRMB)}
                  </span>
                )}
                {suggestedPriceInfo.unfixableChannelCount > 0 && (
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-orange-600">
                    {suggestedPriceInfo.unfixableChannelCount} 个渠道调价仍不可修复
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 目标利润率 */}
          <div className="space-y-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleMarginLock}
                    className={`flex items-center gap-1 text-xs font-medium transition-colors cursor-pointer select-none ${
                      lockedMargin !== null ? "text-amber-600" : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {lockedMargin !== null ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                    <span>目标利润率</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8} className="max-w-xs z-[9999] bg-white border border-slate-200 shadow-lg p-3">
                  <p className="text-xs text-slate-600">
                    {lockedMargin !== null 
                      ? "锁定中 — 更改成本时售价将自动调整以维持该利润率，点击解锁" 
                      : "点击锁定利润率，锁定后更改成本将自动调整售价"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">%</span>
                <Input
                  type="number"
                  min="-99"
                  max="99"
                  step="1"
                  value={targetMarginInput}
                  onChange={(e) => {
                    if (lockedMargin !== null) return; // 🔹 锁定时禁止编辑
                    const val = e.target.value;
                    setTargetMarginInput(val); // 更新本地状态
                    
                    // 🔹 设置输入源标记，防止售价更新后再次触发利润率同步
                    isUpdatingFromMargin.current = true;
                    
                    if (val === "" || val === "-") {
                      // 空值或负号，不触发计算
                    } else {
                      const targetMargin = parseFloat(val);
                      if (onReversePriceFromMargin && !isNaN(targetMargin)) {
                        onReversePriceFromMargin(targetMargin);
                      }
                    }
                  }}
                  className={`h-8 text-sm pl-6 ${marginError ? "border-red-400 focus-visible:ring-red-400" : ""} ${lockedMargin !== null ? "bg-amber-50/50 cursor-not-allowed" : ""}`}
                  placeholder="0"
                  disabled={lockedMargin !== null}
                />
              </div>
              <button
                type="button"
                disabled={lockedMargin !== null}
                onClick={() => {
                  if (lockedMargin !== null) return;
                  setTargetMarginInput("20");
                  isUpdatingFromMargin.current = true;
                  onReversePriceFromMargin?.(20);
                }}
                className="h-8 w-11 shrink-0 rounded border border-indigo-200 bg-indigo-50 text-[10px] font-bold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="按 20% 目标利润率反推售价"
              >
                20%
              </button>
            </div>
            {marginError && (
              <div className="text-[10px] text-red-600 font-medium p-1.5 rounded bg-red-50 border border-red-200">
                {marginError}
              </div>
            )}
          </div>
          {ozonPricing.isValid && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="text-xs font-bold text-slate-700">Ozon 后台填写价</div>
                <div className="text-[10px] text-slate-500">前台=后台4折，后台=折前6折</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  {
                    label: "后台定价",
                    valueRMB: ozonPricing.ozonBackendPriceRMB,
                    valueRUB: ozonPricing.ozonBackendPriceRUB,
                  },
                  {
                    label: "折扣前价格",
                    valueRMB: ozonPricing.ozonOriginalPriceRMB,
                    valueRUB: ozonPricing.ozonOriginalPriceRUB,
                  },
                ].map((item) => (
                  <div key={item.label} className="rounded-md border border-white bg-white px-2 py-1.5 shadow-sm">
                    <div className="mb-1 flex items-center justify-between gap-1">
                      <span className="text-[10px] font-medium text-slate-500">{item.label}</span>
                      <button
                        type="button"
                        onClick={() => onCopyOzonPrice?.(item.label, String(item.valueRMB))}
                        className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        title={`复制${item.label}`}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="text-sm font-black tabular-nums text-slate-800">¥{item.valueRMB.toFixed(2)}</div>
                    <div className="text-[10px] text-slate-500">≈ ₽{item.valueRUB.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* 🔹 竞品价格对比 - 简化版 */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">竞品售价</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={numberInputValue(rivalPrice)}
                onChange={(e) => updateField("rivalPrice", parseFloat(e.target.value) || 0)}
                className="h-8 text-sm flex-1"
                placeholder="输入竞品售价"
              />
              <div className="flex rounded-lg overflow-hidden border">
                <button
                  type="button"
                  onClick={() => {
                    // 切换到 RMB
                    if (rivalCurrency !== 'RMB') {
                      const val = rivalPrice || 0;
                      if (rivalCurrency === 'RUB' && val > 0) {
                        // RUB 转 RMB
                        updateField("rivalPrice", val / input.exchangeRate);
                      }
                      updateField("rivalCurrency", 'RMB');
                    }
                  }}
                  className={`px-2 py-1 text-xs font-medium transition-colors ${
                    rivalCurrency === 'RMB' ? "bg-indigo-500 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  ¥
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // 切换到 RUB
                    if (rivalCurrency !== 'RUB') {
                      const val = rivalPrice || 0;
                      if (rivalCurrency === 'RMB' && val > 0) {
                        // RMB 转 RUB
                        updateField("rivalPrice", val * input.exchangeRate);
                      }
                      updateField("rivalCurrency", 'RUB');
                    }
                  }}
                  className={`px-2 py-1 text-xs font-medium transition-colors ${
                    rivalCurrency === 'RUB' ? "bg-indigo-500 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  ₽
                </button>
              </div>
            </div>
            {/* 对比结果 */}
            {rivalPrice && rivalPrice > 0 && input.targetPriceRMB > 0 && (() => {
              const rivalInRMB = rivalCurrency === 'RUB' ? rivalPrice / input.exchangeRate : rivalPrice;
              const diff = input.targetPriceRMB - rivalInRMB;
              const isHigher = diff >= 0;
              // 🔴 修复：售价高于竞品 → 价格劣势（红色），低于竞品 → 价格优势（绿色）
              return (
                <div className={`text-xs p-2 rounded-md font-medium ${isHigher ? "text-orange-700 bg-orange-50" : "text-green-700 bg-green-50"}`}>
                  {isHigher ? "⚠️ 高于竞品" : "✓ 低于竞品"} ¥{Math.abs(diff).toFixed(2)}
                </div>
              );
            })()}
          </div>
          {/* 🔹 利润预警阈值 */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">利润率预警阈值 (%)</Label>
            <Input
              type="number"
              min="0"
              max="99"
              step="1"
              value={input.profitWarningThreshold !== null && input.profitWarningThreshold !== undefined ? input.profitWarningThreshold : ""}
              onChange={(e) => updateField("profitWarningThreshold", optionalNumberInputValue(e.target.value))}
              className="h-8 text-sm"
              placeholder="留空关闭预警"
            />
            {input.profitWarningThreshold !== null && input.profitWarningThreshold !== undefined && currentProfitMargin !== undefined && (
              <div className={`text-xs p-2 rounded-md font-medium ${!isProfitMarginBelowThreshold(currentProfitMargin, input.profitWarningThreshold) ? "text-green-700 bg-green-50 border border-green-200" : "text-amber-700 bg-amber-50 border border-amber-200"}`}>
                当前 {currentProfitMargin.toFixed(1)}% {!isProfitMarginBelowThreshold(currentProfitMargin, input.profitWarningThreshold) ? "✓ 达标" : "⚠️ 低于阈值"}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">预留大促折扣</Label>
            <Input
              type="number"
              min="0"
              max="99"
              step="1"
              value={numberInputValue(input.promotionDiscount)}
              onChange={(e) => updateField("promotionDiscount", parseFloat(e.target.value) || 0)}
              className="h-8 text-sm"
            />
            {input.promotionDiscount > 0 && input.targetPriceRMB > 0 && (
              <div className="text-xs text-muted-foreground p-2 rounded-md bg-muted/30">
                <span className="font-medium">划线原价:</span>{" "}
                ¥{(input.targetPriceRMB / (1 - input.promotionDiscount / 100)).toFixed(2)}
                {" "}(≈{(input.targetPriceRMB / (1 - input.promotionDiscount / 100) * input.exchangeRate).toFixed(0)} ₽)
              </div>
            )}
          </div>

          {/* 🔹 支付手续费 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">支付手续费 (%)</Label>
              <span className="text-[10px] text-slate-500">Ozon 平台扣费</span>
            </div>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={numberInputValue(input.paymentFee)}
              onChange={(e) => updateField("paymentFee", parseFloat(e.target.value) || 0)}
              className="h-8 text-sm"
            />
          </div>

          {/* 🔹 税务模拟 */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-xs font-medium">税务模拟</Label>
                <div className={`text-[10px] mt-0.5 ${input.taxEnabled ? "text-emerald-700" : "text-muted-foreground"}`}>
                  {input.taxEnabled ? "已开启：Dashboard 将展示税后净利" : "已关闭：当前使用默认税前口径"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => updateField("taxEnabled", !input.taxEnabled)}
                className={`relative inline-flex h-8 w-[76px] shrink-0 items-center rounded-full border-2 px-1 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                  input.taxEnabled
                    ? "border-emerald-600 bg-emerald-600 text-white focus:ring-emerald-300"
                    : "border-slate-300 bg-slate-200 text-slate-500 focus:ring-slate-300"
                }`}
                aria-pressed={input.taxEnabled}
                aria-label={input.taxEnabled ? "关闭税务模拟" : "开启税务模拟"}
                data-testid="tax-toggle"
              >
                <span
                  className={`absolute h-6 w-6 rounded-full bg-white shadow transition-transform ${
                    input.taxEnabled ? "translate-x-[42px]" : "translate-x-0"
                  }`}
                />
                <span className={`relative z-10 flex-1 text-center text-[10px] font-extrabold ${input.taxEnabled ? "opacity-0" : "opacity-100"}`}>
                  OFF
                </span>
                <span className={`relative z-10 flex-1 text-center text-[10px] font-extrabold ${input.taxEnabled ? "opacity-100" : "opacity-0"}`}>
                  ON
                </span>
              </button>
            </div>
            <div className={`grid grid-cols-2 gap-2 ${input.taxEnabled ? "opacity-100" : "opacity-45"}`}>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">增值税率 (%)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={numberInputValue(input.vatRate)}
                  onChange={(e) => updateField("vatRate", parseFloat(e.target.value) || 0)}
                  className="h-8 text-sm"
                  disabled={!input.taxEnabled}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">企业所得税 (%)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={numberInputValue(input.corporateTaxRate)}
                  onChange={(e) => updateField("corporateTaxRate", parseFloat(e.target.value) || 0)}
                  className="h-8 text-sm"
                  disabled={!input.taxEnabled}
                />
              </div>
            </div>
          </div>
          
        </div>
      </Section>
    </div>
  );
}
