"use client";

import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from "react";
import * as XLSX from "xlsx";
import { InputPanel } from "@/components/input-panel";
import { Dashboard } from "@/components/dashboard";
import { LogisticsCard } from "@/components/logistics-card";
import { useDataHub } from "@/lib/data-hub-context";
import { RotateCcw, Truck, Upload, FileText, Settings, AlertCircle, RefreshCw, Clock, Star, WalletCards, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { CalculationInput, ShippingChannel, CalculationResult, UnavailableShippingChannel } from "@/lib/types";
import {
  performFullCalculation,
  calculateProfitCurve,
  calculateExchangeRateStressTest,
  calculateMultiItemProfit,
  getChargeableWeight,
  reversePriceFromMargin,
  calculateSixTierPricing,
  calculateSuggestedPrice,
  calculateCpcCost,
} from "@/lib/calculator";
import { calculateShippingCost, parseBillingWeight, getBillingModeDescription } from "@/lib/data-hub-context";
import { PreviewMappingDialog } from "@/components/preview-mapping-dialog";
import { FieldMapping, ParsedData, smartParseCSV } from "@/lib/smart-parser";
import { cnyToRub } from "@/lib/currency";
import { parseBatchInput as parseBatchCsvInput } from "@/lib/batch-parsing";
import {
  downloadBatchTemplate,
  downloadCommissionTemplate,
  downloadShippingTemplate,
} from "@/lib/template-export";
import { calculateOzonBackendPricing } from "@/lib/ozon-pricing";
import { isProfitMarginBelowThreshold } from "@/lib/profit-threshold";
import { selectShippingSheetName } from "@/lib/shipping-workbook";
import { selectCommissionSheetName } from "@/lib/commission-parsing";

// 默认输入：售价为 RMB（1500 RUB ÷ 12 = 125 RMB）
const DEFAULT_INPUT: CalculationInput = {
  primaryCategory: "电子产品",
  secondaryCategory: "电子产品配饰",
  tertiaryCategory: "",
  length: 20,
  width: 15,
  height: 10,
  weight: 300,
  hasBattery: false, // 🔹 是否带电，默认否
  hasLiquid: false, // 🔹 是否带液体，默认否
  designatedProviders: [], // 🔹 指定物流商数组
  purchaseCost: 30,
  domesticShipping: 3,
  packagingFee: 2,
  returnRate: 5,
  returnHandling: "destroy",
  cpaEnabled: false,
  cpaRate: 5,
  cpcEnabled: false,
  cpcBillingMode: "bidCvr",
  cpcBid: 10,
  cpcConversionRate: 3,
  cpcSalesPercent: 0,
  targetPriceRMB: 125, // RMB（≈1500 RUB）
  promotionDiscount: 0,
  exchangeRate: 12.0, // 1 CNY = 12 RUB
  withdrawalFee: 1.5,
  paymentFee: 1,
  exchangeRateBuffer: 0, // 汇率安全缓冲：默认0%
  valueLimitCurrency: "RMB",
  fulfillmentMode: "RFBS",
  rivalPrice: 0, // 竞品售价
  rivalCurrency: 'RMB' as const, // 竞品售价货币模式
  multiItemCount: 1, // 单单购买数量
  taxEnabled: false, // 税务核算默认关闭
  vatRate: 13, // 增值税率 13%
  corporateTaxRate: 25, // 企业所得税率 25%
};

const EMPTY_INPUT: CalculationInput = {
  ...DEFAULT_INPUT,
  length: 0,
  width: 0,
  height: 0,
  weight: 0,
  hasBattery: false,
  hasLiquid: false,
  designatedProviders: [],
  purchaseCost: 0,
  domesticShipping: 0,
  packagingFee: 0,
  returnRate: 0,
  cpaEnabled: false,
  cpaRate: 0,
  cpcEnabled: false,
  cpcBillingMode: "bidCvr",
  cpcBid: 0,
  cpcConversionRate: 0,
  cpcSalesPercent: 0,
  targetPriceRMB: 0,
  promotionDiscount: 0,
  withdrawalFee: 0,
  paymentFee: 1,
  exchangeRateBuffer: 0,
  valueLimitCurrency: "RMB",
  fulfillmentMode: "RFBS",
  rivalPrice: 0,
  rivalCurrency: "RMB",
  multiItemCount: 1,
  profitWarningThreshold: 20,
  taxEnabled: false,
  vatRate: 0,
  corporateTaxRate: 0,
};

// localStorage 键名
const STORAGE_KEY = "ozon-calculator-input";
const CONFIG_EXPORT_KEY = "ozon-calculator-config";

// 🔹 工具函数：检查渠道是否支持体积重计费
function supportsVolumetricBilling(channel: ShippingChannel): boolean {
  const billingType = (channel.billingType || "").toLowerCase();
  return billingType.includes("体积") || billingType.includes("取大") || billingType.includes("max");
}

function summarizeInterceptionReasons(unavailable: UnavailableShippingChannel[]): string {
  const counts = new Map<string, number>();
  unavailable.forEach((channel) => {
    channel.interceptionReasons?.forEach((reason) => {
      counts.set(reason.dimension, (counts.get(reason.dimension) || 0) + 1);
    });
  });
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length === 0) {
    return "没有可用物流渠道";
  }
  return `主要拦截：${top.map(([dimension, count]) => `${dimension} ${count}`).join("、")}`;
}

// 🔹 批量计算结果类型
interface BatchResultItem {
  rowIndex: number;
  sku?: string;
  input: CalculationInput;
  selectedChannel: ShippingChannel | null;
  result: CalculationResult | null;
  status: "success" | "failed";
  errorReason?: string;
  netProfit?: number;
  roi?: number;
  profitMargin?: number;
  availableChannelCount: number;
  unavailableChannelCount: number;
  riskLevel: "低" | "中" | "高";
  hasVolumetric: boolean;
  suggestedPriceRMB?: number;
}

type BatchSortMode = "profit" | "roi" | "risk" | "available" | "volumetric";

function csvEscape(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | undefined | null>>) {
  const content = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function getFinanceTextClass(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "text-slate-700";
  }
  return value >= 0 ? "text-red-700" : "text-emerald-700";
}

async function readTabularFileAsCsv(file: File, type?: "commission" | "shipping" | "batch"): Promise<{ csvContent: string; sheetName?: string }> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = type === "shipping"
      ? selectShippingSheetName(workbook.SheetNames)
      : type === "commission"
        ? selectCommissionSheetName(workbook.SheetNames)
        : workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error("未找到可解析的工作表");
    }
    const worksheet = workbook.Sheets[sheetName];
    return {
      csvContent: XLSX.utils.sheet_to_csv(worksheet),
      sheetName,
    };
  }
  return { csvContent: await file.text() };
}

type TopAlertSeverity = "danger" | "warning" | "info" | "success";

interface TopAlertItem {
  id: string;
  severity: TopAlertSeverity;
  label: ReactNode;
  plainText: string;
  detail?: ReactNode;
  action?: ReactNode;
}

const topAlertClassBySeverity: Record<TopAlertSeverity, string> = {
  danger: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-indigo-200 bg-indigo-50 text-indigo-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

function TopAlertBadge({
  item,
  onDismiss,
  duplicate = false,
  marquee = false,
}: {
  item: TopAlertItem;
  onDismiss: (id: string) => void;
  duplicate?: boolean;
  marquee?: boolean;
}) {
  return (
    <div className={`inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold shadow-sm ${marquee ? "max-w-none" : "max-w-[520px]"} ${duplicate ? "pointer-events-none" : ""} ${topAlertClassBySeverity[item.severity]}`}>
      <span className={`min-w-0 whitespace-nowrap ${marquee ? "" : "truncate"}`}>{item.label}</span>
      {!duplicate && item.detail}
      {!duplicate && item.action}
      <button
        type="button"
        aria-label="清除此提示"
        tabIndex={duplicate ? -1 : 0}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (duplicate) return;
          onDismiss(item.id);
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (duplicate) return;
          onDismiss(item.id);
        }}
        className="ml-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-current opacity-55 hover:bg-white/60 hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function TopAlertBar({ items, onDismiss }: { items: TopAlertItem[]; onDismiss: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateWidth = () => setAvailableWidth(element.clientWidth);
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  if (items.length === 0) return null;

  const totalTextLength = items.reduce((sum, item) => sum + item.plainText.length, 0);
  const estimatedContentWidth = totalTextLength * 7 + items.length * 78;
  const useMarquee = items.length > 4 || totalTextLength > 72 || (availableWidth > 0 && estimatedContentWidth > availableWidth);
  const renderedItems = items.map((item) => <TopAlertBadge key={item.id} item={item} onDismiss={onDismiss} marquee={useMarquee} />);

  if (!useMarquee) {
    return (
      <div ref={containerRef} className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-2 overflow-hidden">
        {renderedItems}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="top-alert-marquee group min-w-0 flex-1 overflow-hidden rounded-md border border-slate-200 bg-white/70 px-1.5 py-1 focus-within:[--alert-marquee-state:paused] hover:[--alert-marquee-state:paused]">
      <div className="top-alert-marquee-track flex w-max items-center gap-2 [animation-play-state:var(--alert-marquee-state,running)]">
        {renderedItems}
        <div aria-hidden="true" className="flex items-center gap-2 pl-2">
          {items.map((item) => <TopAlertBadge key={`${item.id}-copy`} item={item} onDismiss={onDismiss} duplicate marquee />)}
        </div>
      </div>
    </div>
  );
}

function getRiskLevel(result: CalculationResult | null, availableCount: number, hasVolumetric: boolean): "低" | "中" | "高" {
  if (!result || availableCount === 0 || result.netProfit < 0 || result.adRiskControl?.isOverBudget) return "高";
  if (hasVolumetric || result.profitMargin < 10 || result.warnings.length > 0) return "中";
  return "低";
}

// 🔹 工具函数：导出配置
function exportConfig() {
  const config = {
    version: "1.0",
    timestamp: new Date().toISOString(),
    input: localStorage.getItem(STORAGE_KEY),
    columnMappings: {
      commission: localStorage.getItem("ozon_commission_mappings"),
      shipping: localStorage.getItem("ozon_shipping_mappings"),
    },
    exchangeRate: localStorage.getItem("ozon_exchange_rate"),
    withdrawalFee: localStorage.getItem("ozon_withdrawal_fee"),
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ozon_config_${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// 🔹 工具函数：导入配置
function importConfig(onSuccess: () => void, onError: (err: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const config = JSON.parse(text);
      if (!config.version) throw new Error("无效的配置文件");
      if (config.input) localStorage.setItem(STORAGE_KEY, config.input);
      if (config.columnMappings?.commission) localStorage.setItem("ozon_commission_mappings", config.columnMappings.commission);
      if (config.columnMappings?.shipping) localStorage.setItem("ozon_shipping_mappings", config.columnMappings.shipping);
      if (config.exchangeRate) localStorage.setItem("ozon_exchange_rate", config.exchangeRate);
      if (config.withdrawalFee) localStorage.setItem("ozon_withdrawal_fee", config.withdrawalFee);
      onSuccess();
    } catch (err) {
      onError(err instanceof Error ? err.message : "导入失败");
    }
  };
  input.click();
}

export default function Home() {
  const { getCommissionByCategory, getShippingChannels, commissionData, shippingData, commissionLoaded, shippingLoaded, loadCommissionData, loadShippingData, updateColumnMapping, updateInterceptionConfig, lastImportSummary } = useDataHub();
  const [input, setInput] = useState<CalculationInput>(DEFAULT_INPUT);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [marginError, setMarginError] = useState<string | null>(null);
  const [showAllAvailable, setShowAllAvailable] = useState(false); // 🔹 显示全部可用渠道
  const [showAllUnavailable, setShowAllUnavailable] = useState(false); // 🔹 显示全部不可用渠道
  const [sortMode, setSortMode] = useState<'cost' | 'time' | 'rating'>('cost'); // 🔹 推荐物流排序模式
  const [dataManagementOpen, setDataManagementOpen] = useState(false); // 🔹 数据管理抽屉状态
  const [commissionFileName, setCommissionFileName] = useState<string>("");
  const [shippingFileName, setShippingFileName] = useState<string>("");
  
  // 🔹 CSV 映射弹窗状态
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [mappingDataType, setMappingDataType] = useState<"commission" | "shipping">("shipping");
  const [pendingMappingFile, setPendingMappingFile] = useState<File | null>(null);
  const [parsedCsvData, setParsedCsvData] = useState<ParsedData | null>(null);
  
  // 防抖保存的定时器
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // 🔹 自动获取汇率
  const [isFetchingRate, setIsFetchingRate] = useState(false);
  const [rateFetchError, setRateFetchError] = useState<string | null>(null);
  // 🔹 利润率锁定状态：null=未锁定, 数字=锁定的利润率值(%)
  const [lockedMargin, setLockedMargin] = useState<number | null>(null);
  
  // 🔹 致命错误诊断面板显
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  
  // 🔹 ESC 键关闭诊断面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showDiagnostic) {
        setShowDiagnostic(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDiagnostic]);
  
  // 🔹 渠道收藏夹
  const [favoriteChannels, setFavoriteChannels] = useState<string[]>([]);
  
  // 🔹 上传成功提示状态
  const [uploadToast, setUploadToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(() => new Set());
  
  // 🔹 上传提示自动消失
  useEffect(() => {
    if (uploadToast) {
      const timer = setTimeout(() => setUploadToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [uploadToast]);
  
  // 加载收藏夹
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ozon-favorite-channels");
      if (saved) {
        setFavoriteChannels(JSON.parse(saved));
      }
    } catch {}
  }, []);
  
  // 🔹 批量计算状态
  const [batchResults, setBatchResults] = useState<BatchResultItem[]>([]);
  const [isBatchCalculating, setIsBatchCalculating] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchSortMode, setBatchSortMode] = useState<BatchSortMode>("profit");
  
  const fetchExchangeRate = useCallback(async () => {
    setIsFetchingRate(true);
    setRateFetchError(null);
    try {
      // 🔴 缓存：5分钟内不重复请求
      const cacheKey = "ozon_exchange_rate_cache";
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { rate, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < 5 * 60 * 1000 && rate > 0) {
          setInput(prev => ({ ...prev, exchangeRate: parseFloat(rate.toFixed(4)) }));
          setIsFetchingRate(false);
          return;
        }
      }
      
      const response = await fetch('https://open.er-api.com/v6/latest/RUB');
      if (!response.ok) throw new Error('汇率API请求失败');
      const data = await response.json();
      if (data.rates && data.rates.CNY) {
        // API返回: 1 RUB = X CNY, 需要转为: 1 CNY = X RUB
        const rateRUBperCNY = 1 / parseFloat(data.rates.CNY.toFixed(6));
        setInput(prev => ({ ...prev, exchangeRate: parseFloat(rateRUBperCNY.toFixed(4)) }));
        // 缓存汇率
        localStorage.setItem(cacheKey, JSON.stringify({ rate: rateRUBperCNY, timestamp: Date.now() }));
      }
    } catch (error) {
      console.error('获取汇率失败:', error);
      setRateFetchError('无法获取实时汇率，请手动输入');
    } finally {
      setIsFetchingRate(false);
    }
  }, []);

  // 组件加载时自动获取汇率
  useEffect(() => {
    fetchExchangeRate();
  }, []);

  // 🔹 页面加载时从 localStorage 恢复数据
  useEffect(() => {
    try {
      const savedData = localStorage.getItem(STORAGE_KEY);
      if (savedData) {
        const parsedData = JSON.parse(savedData) as CalculationInput;
        setInput({
          ...DEFAULT_INPUT,
          ...parsedData,
          cpcBillingMode: parsedData.cpcBillingMode || "bidCvr",
          cpcSalesPercent: parsedData.cpcSalesPercent || 0,
          valueLimitCurrency: parsedData.valueLimitCurrency || "RMB",
          fulfillmentMode: parsedData.fulfillmentMode || "RFBS",
          tertiaryCategory: parsedData.tertiaryCategory || "",
        });
      }
      
      // 旧版本会持久锁定物流渠道；新版只保留当前会话临时选择。
      localStorage.removeItem("ozon-locked-channel");

      // 🔹 恢复利润率锁定状态
      const savedLockedMargin = localStorage.getItem("ozon-locked-margin");
      if (savedLockedMargin !== null) {
        setLockedMargin(parseFloat(savedLockedMargin));
      }
    } catch (error) {
      console.error("Failed to load saved data:", error);
    }
  }, []);

  // 🔹 自动保存到 localStorage（带防抖，避免频繁写入）
  useEffect(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(input));
      } catch (error) {
        console.error("Failed to save data:", error);
      }
    }, 500); // 500ms 防抖延迟

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [input]);

  // 全局汇率和提现费同步
  const handleExchangeRateChange = useCallback((rate: number) => {
    setInput((prev) => ({ ...prev, exchangeRate: rate }));
  }, []);

  const handleWithdrawalFeeChange = useCallback((fee: number) => {
    setInput((prev) => ({ ...prev, withdrawalFee: fee }));
  }, []);

  const handleExchangeRateBufferChange = useCallback((buffer: number) => {
    setInput((prev) => ({ ...prev, exchangeRateBuffer: buffer }));
  }, []);

  // 获取当前类目的佣金配置
  const commission = useMemo(
    () => getCommissionByCategory(input.primaryCategory, input.secondaryCategory, input.tertiaryCategory),
    [input.primaryCategory, input.secondaryCategory, input.tertiaryCategory, getCommissionByCategory]
  );

  // 🔹 计算实际汇率（扣除安全缓冲），单位固定为 1 CNY = X RUB
  const effectiveRubPerCny = useMemo(() => {
    // 用户输入表示: 1 CNY = X RUB
    // buffer > 0 时，实际汇率 = 原汇率 × (1 - buffer/100)
    const bufferMultiplier = 1 - (input.exchangeRateBuffer || 0) / 100;
    const adjustedRate = input.exchangeRate * Math.max(bufferMultiplier, 0.5); // 最低保护50%
    return adjustedRate > 0 ? adjustedRate : 12;
  }, [input.exchangeRate, input.exchangeRateBuffer]);

  // 获取可用物流渠道 — 需要将 RMB 转为 RUB 传入（使用实际汇率）
  const selectedProviders = input.designatedProviders || [];
  const isFavoritesFilter = selectedProviders.includes("__favorites__");
  const providers = selectedProviders.filter(p => p && p !== "__favorites__");
  
  const baseShippingChannels = useMemo(() => {
    // 转换为逗号分隔的字符串（空表示全部）
    const providerStr = providers.length > 0 ? providers.join(",") : "";
    return getShippingChannels(
      input.length,
      input.width,
      input.height,
      input.weight,
      input.targetPriceRMB,
      effectiveRubPerCny,
      input.valueLimitCurrency,
      input.hasBattery, // 🔹 传入是否带电
      input.hasLiquid, // 🔹 传入是否带液体
      providerStr // 🔹 使用物流商筛选
    );
  }, [input.length, input.width, input.height, input.weight, input.targetPriceRMB, effectiveRubPerCny, input.valueLimitCurrency, input.hasBattery, input.hasLiquid, providers, getShippingChannels]);
  
  // 🔹 应用收藏夹筛选
  const shippingChannels = useMemo(() => {
    if (isFavoritesFilter) {
      // 收藏夹：合并所有渠道后显示
      const allFavorites = shippingData.filter(ch => favoriteChannels.includes(ch.id));
      return {
        available: allFavorites,
        unavailable: [],
      };
    }
    return baseShippingChannels;
  }, [baseShippingChannels, isFavoritesFilter, favoriteChannels, shippingData]);

  // 🔹 智能售价建议：当无可用渠道且未填售价时，分析可修复渠道
  const priceSuggestion = useMemo(() => {
    // 仅在无可用渠道、未填售价、且有尺寸重量数据时计算
    if (shippingChannels.available.length > 0 || input.targetPriceRMB > 0 || input.weight <= 0) {
      return null;
    }
    // 使用 input.exchangeRate (1 CNY = X RUB) 作为 RMB→RUB 转换因子
    return calculateSuggestedPrice(
      shippingChannels.unavailable,
      effectiveRubPerCny,
      input.valueLimitCurrency,
      { ...input, exchangeRate: effectiveRubPerCny },
      commission,
      20
    );
  }, [shippingChannels, input, commission, effectiveRubPerCny]);

  // 🔹 推荐物流排序：按费用/时效/评分排序（定义在 channelCosts 之后，见下方）

  const getRecommendedChannel = useCallback((channels: ShippingChannel[]) => {
    const sorted = [...channels];
    switch (sortMode) {
      case "cost":
        sorted.sort((a, b) => {
          const costA = calculateShippingCost(a, input.weight, input.length, input.width, input.height, input.weight);
          const costB = calculateShippingCost(b, input.weight, input.length, input.width, input.height, input.weight);
          return costA - costB;
        });
        break;
      case "time":
        sorted.sort((a, b) => a.deliveryTime - b.deliveryTime);
        break;
      case "rating":
        sorted.sort((a, b) => (b.ozonRating || 0) - (a.ozonRating || 0));
        break;
    }
    return sorted[0] || null;
  }, [input.height, input.length, input.weight, input.width, sortMode]);

  useEffect(() => {
    if (!selectedChannelId) return;
    const stillAvailable = shippingChannels.available.some((channel) => channel.id === selectedChannelId);
    if (!stillAvailable) {
      setSelectedChannelId(null);
    }
  }, [selectedChannelId, shippingChannels.available]);

  // 默认选中当前推荐排序下的第一条；用户点击后仅当前会话临时选择。
  const selectedChannel = useMemo(() => {
    if (selectedChannelId) {
      const ch = shippingChannels.available.find((c) => c.id === selectedChannelId);
      if (ch) return ch;
    }
    return getRecommendedChannel(shippingChannels.available);
  }, [selectedChannelId, shippingChannels.available, getRecommendedChannel]);

  // 🔹 创建计算用的 input（使用实际 RUB/CNY 汇率）
  const effectiveInput = useMemo(() => {
    return {
      ...input,
      exchangeRate: effectiveRubPerCny,
    };
  }, [input, effectiveRubPerCny]);

  // 执行完整计算（使用实际汇率）
  const result = useMemo(
    () => performFullCalculation(effectiveInput, commission, selectedChannel),
    [effectiveInput, commission, selectedChannel]
  );
  
  // 🔹 利润率锁定时：成本变化自动反推售价
  // 注意：监听输入参数而非结果，防止无限循环
  const lockedMarginRef = useRef(lockedMargin);
  useEffect(() => {
    if (lockedMargin === null || !commission) return;
    
    // 防止在同一渲染周期内重复触发
    if (lockedMarginRef.current === lockedMargin) {
      const reverseResult = reversePriceFromMargin(lockedMargin, effectiveInput, commission, selectedChannel || undefined);
      
      if (reverseResult.error) {
        setMarginError(reverseResult.error);
      } else if (reverseResult.priceRMB > 0) {
        setMarginError(null);
        setInput((prev) => ({ ...prev, targetPriceRMB: reverseResult.priceRMB }));
      }
    }
    lockedMarginRef.current = lockedMargin;
  }, [
    // 🔹 监听影响成本的输入参数变化
    // 使用 input 对象而非 result，避免循环依赖
    effectiveInput.purchaseCost,
    effectiveInput.domesticShipping,
    effectiveInput.packagingFee,
    effectiveInput.weight,
    effectiveInput.length,
    effectiveInput.width,
    effectiveInput.height,
    effectiveInput.cpcEnabled,
    effectiveInput.cpcBillingMode,
    effectiveInput.cpcBid,
    effectiveInput.cpcConversionRate,
    effectiveInput.cpcSalesPercent,
    effectiveInput.exchangeRate,
    effectiveInput.withdrawalFee,
    effectiveInput.paymentFee,
    effectiveInput.fulfillmentMode,
    lockedMargin,
    commission,
    selectedChannel,
  ]);
  
  // 🔹 监控佣金阶梯变化
  useEffect(() => {
    // 佣金阶梯变化监控已移除调试日志
  }, [effectiveInput.targetPriceRMB, effectiveInput.exchangeRate, result.commissionRate, commission]);
  
  // 🔹 调试：输出当前使用的佣金数据
  useEffect(() => {
    // 佣金数据调试日志已移除
  }, [commission]);

  // 计算六档定价推荐矩阵（使用实际汇率）
  const sixTierPricing = useMemo(() => {
    if (!commission) return [];
    return calculateSixTierPricing(effectiveInput, commission, selectedChannel || undefined);
  }, [effectiveInput, commission, selectedChannel]);

  // 🔹 优化：共享的总固定成本计算 - 避免重复计算
  const totalFixedCostData = useMemo(() => {
    const chargeableWeight = getChargeableWeight(effectiveInput.length, effectiveInput.width, effectiveInput.height, effectiveInput.weight, selectedChannel || undefined).chargeable;
    const internationalShipping = selectedChannel ? calculateShippingCost(selectedChannel, chargeableWeight) : 0;
    const rate = effectiveInput.returnRate / 100;
    const returnCost = (() => {
      switch (effectiveInput.returnHandling) {
        case "destroy": return (effectiveInput.purchaseCost + effectiveInput.domesticShipping + internationalShipping) * rate;
        case "resell": return internationalShipping * rate;
        case "productOnly": return effectiveInput.purchaseCost * rate;
        default: return 0;
      }
    })();
    const cpcCost = calculateCpcCost(
      effectiveInput.cpcEnabled,
      effectiveInput.cpcBid,
      effectiveInput.cpcConversionRate,
      effectiveInput.exchangeRate,
      effectiveInput.cpcBillingMode || "bidCvr",
      effectiveInput.cpcSalesPercent || 0,
      effectiveInput.targetPriceRMB
    );
    const variableCpcSalesPercent =
      effectiveInput.cpcEnabled && (effectiveInput.cpcBillingMode || "bidCvr") === "salesPercent"
        ? effectiveInput.cpcSalesPercent || 0
        : 0;
    const totalFixedCost = effectiveInput.purchaseCost + effectiveInput.domesticShipping + effectiveInput.packagingFee + internationalShipping + cpcCost + returnCost;
    return {
      totalFixedCost,
      fixedCostForVariablePricing: totalFixedCost - (variableCpcSalesPercent > 0 ? cpcCost : 0),
      variableCpcSalesPercent,
      cpaRateForM: effectiveInput.cpaEnabled ? effectiveInput.cpaRate : 0,
    };
  }, [effectiveInput, selectedChannel]);

  // 保留向后兼容的回调（供外部组件使用）
  const computeTotalFixedCost = useCallback(() => totalFixedCostData, [totalFixedCostData]);

  // 利润曲线数据 — X轴为 RMB 售价
  const profitCurve = useMemo(() => {
    if (!commission) return [];
    const minPrice = Math.max(1, Math.floor(effectiveInput.targetPriceRMB * 0.3));
    const maxPrice = Math.ceil(effectiveInput.targetPriceRMB * 2.5);
    const step = Math.max(0.5, (maxPrice - minPrice) / 80);
    const priceRangeRMB: number[] = [];
    for (let p = minPrice; p <= maxPrice; p += step) {
      priceRangeRMB.push(parseFloat(p.toFixed(2)));
    }
    const { fixedCostForVariablePricing, cpaRateForM, variableCpcSalesPercent } = totalFixedCostData;
    return calculateProfitCurve(priceRangeRMB, effectiveInput.exchangeRate, commission, effectiveInput.withdrawalFee, cpaRateForM, fixedCostForVariablePricing, effectiveInput.paymentFee, variableCpcSalesPercent, effectiveInput.fulfillmentMode || "RFBS");
  }, [commission, effectiveInput, totalFixedCostData]);

  // 汇率抗压测试
  const stressTest = useMemo(() => {
    if (!commission) return { at5PercentDrop: 0, at10PercentDrop: 0, zeroProfitRate: 0 };
    const { fixedCostForVariablePricing, cpaRateForM, variableCpcSalesPercent } = totalFixedCostData;
    return calculateExchangeRateStressTest(effectiveInput.targetPriceRMB, effectiveInput.exchangeRate, commission, effectiveInput.withdrawalFee, cpaRateForM, fixedCostForVariablePricing, effectiveInput.paymentFee, variableCpcSalesPercent, effectiveInput.fulfillmentMode || "RFBS");
  }, [commission, effectiveInput, totalFixedCostData]);

  // 多件装利润
  const multiItemProfit = useMemo(() => {
    if (!commission || !selectedChannel) return null;
    return calculateMultiItemProfit(effectiveInput.multiItemCount || 1, effectiveInput, selectedChannel, commission);
  }, [commission, effectiveInput, selectedChannel]);

  const handleSelectChannel = useCallback((channel: ShippingChannel) => {
    setSelectedChannelId(channel.id);
  }, []);

  // 逆向推价：根据目标利润率反推售价
  const handleReversePriceFromMargin = useCallback((targetMargin: number) => {
    if (!commission) return;
    
    const result = reversePriceFromMargin(targetMargin, effectiveInput, commission, selectedChannel || undefined);
    
    if (result.error) {
      setMarginError(result.error);
    } else {
      setMarginError(null);
      setInput((prev) => ({ ...prev, targetPriceRMB: result.priceRMB }));
    }
  }, [effectiveInput, commission, selectedChannel]);

  // 清除售价时清除利润率错误
  const handleInputChange = useCallback((newInput: CalculationInput) => {
    setInput(newInput);
    if (marginError && newInput.targetPriceRMB !== input.targetPriceRMB) {
      setMarginError(null);
    }
  }, [marginError, input.targetPriceRMB]);

  // 🔹 利润率锁定切换：锁定当前利润率，或解锁
  const handleToggleMarginLock = useCallback(() => {
    setLockedMargin((prev) => {
      if (prev !== null) {
        // 解锁
        localStorage.removeItem("ozon-locked-margin");
        return null;
      }
      // 锁定当前利润率
      const currentMargin = result.profitMargin;
      localStorage.setItem("ozon-locked-margin", String(currentMargin));
      return currentMargin;
    });
  }, [result.profitMargin]);

  // 🔹 一键重置输入：只清空计算输入，不清空已导入的数据表
  const handleReset = useCallback(() => {
    const confirmed = window.confirm(
      "⚠️ 确定要清空当前计算输入吗？\n\n" +
      "此操作将：\n" +
      "• 清空尺寸、重量、成本、售价、广告、税务等输入\n" +
      "• 清除临时物流选择\n" +
      "• 清除利润率锁定、批量结果和已关闭提示\n\n" +
      "已导入的佣金表和物流表会保留。"
    );
    
    if (!confirmed) return;
    
    const nextExchangeRate = Number.isFinite(input.exchangeRate) && input.exchangeRate > 0
      ? input.exchangeRate
      : DEFAULT_INPUT.exchangeRate;

    setInput({
      ...EMPTY_INPUT,
      exchangeRate: nextExchangeRate,
    });
    setSelectedChannelId(null);
    setMarginError(null);
    setLockedMargin(null);
    setBatchResults([]);
    setBatchError(null);
    setIsBatchCalculating(false);
    setShowAllAvailable(false);
    setShowAllUnavailable(false);
    setDismissedAlertIds(new Set());

    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("ozon-locked-channel");
    localStorage.removeItem("ozon-locked-margin");

    setUploadToast({ message: "✅ 已清空计算输入，导入数据已保留", type: "success" });
  }, [input.exchangeRate]);

  // 🔹 佣金表上传处理
  const handleCommissionFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setCommissionFileName(file.name);
    
    try {
      // 读取文件并解析
      const { csvContent, sheetName } = await readTabularFileAsCsv(file, "commission");
      const isOfficialTarifs = sheetName === "Full ChinaHK" || sheetName === "MP Tree Tarifs CN" || /RFBS\s*->/i.test(csvContent);
      if (isOfficialTarifs) {
        const summary = await loadCommissionData(file, "overwrite");
        setUploadToast({ message: `✅ 已识别官方 Tarifs 格式：${summary.categories || 0} 个类目，RFBS ${summary.commissionModeMapped?.RFBS || 0} 条，FBP ${summary.commissionModeMapped?.FBP || 0} 条`, type: "success" });
        e.target.value = "";
        return;
      }
      const parsed = smartParseCSV(csvContent, "commission");
      setParsedCsvData(parsed);
      setMappingDataType("commission");
      setPendingMappingFile(file);
      setMappingDialogOpen(true);
    } catch (err) {
      // 回退到直接加载
      try {
        const summary = await loadCommissionData(file, "overwrite");
        setUploadToast({ message: `✅ 佣金表 "${file.name}" 导入成功：${summary.categories || 0} 个类目`, type: 'success' });
      } catch (loadErr) {
        console.error("上传佣金表失败:", loadErr);
        setUploadToast({ message: `❌ 佣金表导入失败: ${loadErr instanceof Error ? loadErr.message : '未知错误'}`, type: 'error' });
      }
    }
  }, [loadCommissionData]);

  // 🔹 物流表上传处理
  const handleShippingFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setShippingFileName(file.name);
    
    try {
      // 读取文件并解析
      const { csvContent, sheetName } = await readTabularFileAsCsv(file, "shipping");
      const parsed = smartParseCSV(csvContent, "shipping");
      setParsedCsvData(parsed);
      setMappingDataType("shipping");
      setPendingMappingFile(file);
      setMappingDialogOpen(true);
      if (sheetName) {
        setUploadToast({ message: `✅ 已读取物流工作表：${sheetName}`, type: "success" });
      }
    } catch (err) {
      // 回退到直接加载
      try {
        const summary = await loadShippingData(file, "overwrite");
        setUploadToast({ message: `✅ 物流表 "${file.name}" 导入成功：${summary.channels || 0} 条渠道，人民币货值 ${summary.valueRMBMapped || 0} 条，卢布货值 ${summary.valueRUBMapped || 0} 条`, type: 'success' });
      } catch (loadErr) {
        console.error("上传物流表失败:", loadErr);
        setUploadToast({ message: `❌ 物流表导入失败: ${loadErr instanceof Error ? loadErr.message : '未知错误'}`, type: 'error' });
      }
    }
  }, [loadShippingData]);

  const handleBatchFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsBatchCalculating(true);
    setBatchError(null);
    setBatchResults([]);

    try {
      const { csvContent } = await readTabularFileAsCsv(file, "batch");
      const parsed = parseBatchCsvInput(csvContent);
      const parseErrorText = parsed.errors.length > 0 ? parsed.errors.join("\n") : null;
      if (parseErrorText) {
        setBatchError(parseErrorText);
      }

      if (parsed.rows.length === 0) {
        const message = parseErrorText || "批量表没有可计算的数据行";
        setBatchError(message);
        setUploadToast({ message: `❌ 批量导入失败：${message.split("\n")[0]}`, type: "error" });
        return;
      }

      const nextResults: BatchResultItem[] = parsed.rows.map((row, index) => {
        const rowInput: CalculationInput = {
          ...input,
          ...row,
          exchangeRate: effectiveRubPerCny,
          valueLimitCurrency: row.valueLimitCurrency || input.valueLimitCurrency,
          designatedProviders: input.designatedProviders || [],
        };
        const rowCommission = getCommissionByCategory(rowInput.primaryCategory, rowInput.secondaryCategory, rowInput.tertiaryCategory);
        if (!rowCommission) {
          return {
            rowIndex: index + 2,
            sku: row.sku,
            input: rowInput,
            selectedChannel: null,
            result: null,
            status: "failed",
            errorReason: `未匹配佣金类目：${rowInput.primaryCategory || "空"} / ${rowInput.secondaryCategory || "空"}`,
            availableChannelCount: 0,
            unavailableChannelCount: 0,
            riskLevel: "高",
            hasVolumetric: false,
          };
        }

        const providerStr = (rowInput.designatedProviders || [])
          .filter((provider) => provider && provider !== "__favorites__")
          .join(",");
        const rowChannels = getShippingChannels(
          rowInput.length,
          rowInput.width,
          rowInput.height,
          rowInput.weight,
          rowInput.targetPriceRMB,
          effectiveRubPerCny,
          rowInput.valueLimitCurrency,
          rowInput.hasBattery,
          rowInput.hasLiquid,
          providerStr
        );
        const selected = rowChannels.available[0] || null;
        if (!selected) {
          const suggestedPrice = calculateSuggestedPrice(rowChannels.unavailable, effectiveRubPerCny, rowInput.valueLimitCurrency, rowInput, rowCommission, 20);
          return {
            rowIndex: index + 2,
            sku: row.sku,
            input: rowInput,
            selectedChannel: null,
            result: null,
            status: "failed",
            errorReason: summarizeInterceptionReasons(rowChannels.unavailable),
            availableChannelCount: 0,
            unavailableChannelCount: rowChannels.unavailable.length,
            riskLevel: "高",
            hasVolumetric: false,
            suggestedPriceRMB: suggestedPrice.suggestedPriceRMB || undefined,
          };
        }

        const calculation = performFullCalculation(rowInput, rowCommission, selected);
        const hasVolumetric = calculation.isVolumetric;
        return {
          rowIndex: index + 2,
          sku: row.sku,
          input: rowInput,
          selectedChannel: selected,
          result: calculation,
          status: "success",
          netProfit: calculation.netProfit,
          roi: calculation.roi,
          profitMargin: calculation.profitMargin,
          availableChannelCount: rowChannels.available.length,
          unavailableChannelCount: rowChannels.unavailable.length,
          riskLevel: getRiskLevel(calculation, rowChannels.available.length, hasVolumetric),
          hasVolumetric,
        };
      });

      setBatchResults(nextResults);
      const successCount = nextResults.filter((item) => item.status === "success").length;
      const failedCount = nextResults.length - successCount + parsed.errors.length;
      setUploadToast({
        message: `✅ 批量计算完成：成功 ${successCount} 行，失败/警告 ${failedCount} 行`,
        type: successCount > 0 ? "success" : "error",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知错误";
      setBatchError(message);
      setUploadToast({ message: `❌ 批量导入失败：${message}`, type: "error" });
    } finally {
      setIsBatchCalculating(false);
      e.target.value = "";
    }
  }, [effectiveRubPerCny, getCommissionByCategory, getShippingChannels, input]);

  const handleClearBatchResults = useCallback(() => {
    setBatchResults([]);
    setBatchError(null);
  }, []);

  const handleExportBatchResults = useCallback(() => {
    if (batchResults.length === 0) return;
    downloadCsv(
      `ozon_batch_results_${new Date().toISOString().slice(0, 10)}.csv`,
      ["行号", "SKU", "状态", "一级类目", "二级类目", "售价RMB", "净利", "ROI", "利润率", "风险", "可用渠道", "计抛", "推荐物流", "失败/建议"],
      batchResults.map((item) => [
        item.rowIndex,
        item.sku || "",
        item.status === "success" ? "成功" : "失败",
        item.input.primaryCategory,
        item.input.secondaryCategory,
        item.input.targetPriceRMB,
        item.netProfit?.toFixed(2),
        item.roi?.toFixed(1),
        item.profitMargin?.toFixed(1),
        item.riskLevel,
        item.availableChannelCount,
        item.hasVolumetric ? "是" : "否",
        item.selectedChannel ? `${item.selectedChannel.thirdParty}-${item.selectedChannel.name}` : "",
        item.errorReason || (item.suggestedPriceRMB ? `建议售价>=${Math.ceil(item.suggestedPriceRMB)}` : ""),
      ])
    );
  }, [batchResults]);

  const handleExportSingleReport = useCallback(() => {
    const activeTax = result.taxes?.enabled ? result.taxes : null;
    const firstSuggestion = result.suggestions[0] || (result.netProfit < 0 ? "提高售价或降低成本" : "继续观察物流与广告风险");
    const ozonPricing = calculateOzonBackendPricing(input.targetPriceRMB, input.exchangeRate);
    downloadCsv(
      `ozon_single_report_${new Date().toISOString().slice(0, 10)}.csv`,
      ["模块", "项目", "值", "说明"],
      [
        ["输入", "一级类目", input.primaryCategory, ""],
        ["输入", "二级类目", input.secondaryCategory, ""],
        ...(input.tertiaryCategory ? [["输入", "三级类目", input.tertiaryCategory, ""]] : []),
        ["输入", "经营模式", input.fulfillmentMode || "RFBS", "平台佣金口径"],
        ["输入", "尺寸", `${input.length}x${input.width}x${input.height} cm`, ""],
        ["输入", "重量", input.weight, "g"],
        ["定价", "售价RMB", input.targetPriceRMB, ""],
        ["定价", "售价RUB", cnyToRub(input.targetPriceRMB, input.exchangeRate).toFixed(0), ""],
        ...(ozonPricing.isValid ? [
          ["定价", "Ozon后台定价RMB", String(ozonPricing.ozonBackendPriceRMB), "前台售价 ÷ 40%"],
          ["定价", "Ozon折扣前价格RMB", String(ozonPricing.ozonOriginalPriceRMB), "后台定价 ÷ 60%"],
          ["定价", "Ozon后台定价RUB", ozonPricing.ozonBackendPriceRUB, "参考平台币种"],
          ["定价", "Ozon折扣前价格RUB", ozonPricing.ozonOriginalPriceRUB, "参考平台币种"],
        ] : []),
        ["结果", "净利润", result.netProfit.toFixed(2), "默认税前口径"],
        ["结果", "ROI", result.roi.toFixed(1), "%"],
        ["结果", "利润率", result.profitMargin.toFixed(1), "%"],
        ["成本", "总成本", result.costs.total.toFixed(2), ""],
        ["成本", "支付手续费", result.costs.paymentFee.toFixed(2), `${input.paymentFee || 0}%`],
        ["物流", "选中渠道", selectedChannel ? `${selectedChannel.thirdParty}-${selectedChannel.name}` : "无", ""],
        ["物流", "计费重", result.chargeableWeight.toFixed(0), "g"],
        ["风险", "警告", result.warnings.join(" | "), ""],
        ["建议", "首要建议", firstSuggestion, ""],
        ["汇率", "5%下跌利润", stressTest.at5PercentDrop.toFixed(2), ""],
        ["汇率", "10%下跌利润", stressTest.at10PercentDrop.toFixed(2), ""],
        ...(activeTax ? [
          ["税务", "增值税估算", activeTax.vatPayable.toFixed(2), ""],
          ["税务", "企业所得税", activeTax.corporateTax.toFixed(2), ""],
          ["税务", "税后净利", activeTax.afterTaxNetProfit.toFixed(2), ""],
        ] : []),
      ]
    );
  }, [input, result, selectedChannel, stressTest]);

  const handleCopyOzonPrice = useCallback(async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setUploadToast({ message: `✅ 已复制${label}: ${value}`, type: "success" });
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setUploadToast({ message: `✅ 已复制${label}: ${value}`, type: "success" });
    }
  }, []);
  
  // 🔹 映射确认处理
  const handleMappingConfirm = useCallback(async (mappings: FieldMapping[]) => {
    setMappingDialogOpen(false);
    
    if (pendingMappingFile) {
      try {
        if (mappingDataType === "commission") {
          const mappingRecord = Object.fromEntries(
            mappings.map((m) => [m.systemField, m.columnIndex])
          ) as Record<string, number>;
          updateColumnMapping("commission", mappingRecord);
          const summary = await loadCommissionData(pendingMappingFile, "overwrite", mappingRecord);
          setUploadToast({ message: `✅ 佣金表导入成功：${summary.categories || 0} 个类目`, type: 'success' });
        } else {
          const mappingRecord = Object.fromEntries(
            mappings.map((m) => [m.systemField, m.columnIndex])
          ) as Record<string, number>;
          updateColumnMapping("shipping", mappingRecord);
          const summary = await loadShippingData(pendingMappingFile, "overwrite", mappingRecord);
          setUploadToast({ message: `✅ 物流表导入成功：${summary.channels || 0} 条渠道，人民币货值 ${summary.valueRMBMapped || 0} 条，卢布货值 ${summary.valueRUBMapped || 0} 条`, type: 'success' });
          
          // 🔹 物流表：提取拦截配置并保存
          const config: Record<string, boolean> = {};
          mappings.forEach(m => {
            if (m.interceptionEnabled !== undefined) {
              config[m.systemField] = m.interceptionEnabled;
            }
          });
          updateInterceptionConfig(config);
        }
      } catch (err) {
        console.error("上传数据失败:", err);
      }
    }
    
    setPendingMappingFile(null);
    setParsedCsvData(null);
  }, [pendingMappingFile, mappingDataType, loadCommissionData, loadShippingData, updateColumnMapping, updateInterceptionConfig]);
  
  // 🔹 映射取消处理
  const handleMappingCancel = useCallback(() => {
    setMappingDialogOpen(false);
    setPendingMappingFile(null);
    setParsedCsvData(null);
  }, []);

  // 计算卢布售价
  // 🔴 修复：exchangeRate = 1 CNY 对应的 RUB 数量，RMB → RUB 应使用乘法
  const priceRUB = cnyToRub(input.targetPriceRMB, input.exchangeRate);

  const interceptionBreakdown = useMemo(() => {
    const base = ["货值", "实重", "边长", "尺寸总和", "体积重", "电池", "液体"];
    const counts = new Map<string, number>(base.map((key) => [key, 0]));
    shippingChannels.unavailable.forEach((channel) => {
      channel.interceptionReasons?.forEach((reason) => {
        counts.set(reason.dimension, (counts.get(reason.dimension) || 0) + 1);
      });
    });
    return Array.from(counts.entries()).map(([dimension, count]) => ({ dimension, count }));
  }, [shippingChannels.unavailable]);

  const dataStatus = useMemo(() => {
    const valueCoverage = shippingData.length > 0
      ? Math.round((shippingData.filter((ch) => ch.minValue !== undefined || ch.maxValue !== undefined || ch.minValueRUB !== undefined || ch.maxValueRUB !== undefined).length / shippingData.length) * 100)
      : 0;
    const missingLogisticsFields = shippingData.filter((ch) => !ch.volumetricDivisor || !ch.deliveryTime || !ch.maxWeight).length;
    const usingDefaultData = commissionLoaded && shippingLoaded && !lastImportSummary && commissionData.length > 0 && shippingData.length > 0;
    return {
      commissionCategories: commissionData.length,
      shippingChannels: shippingData.length,
      valueCoverage,
      missingLogisticsFields,
      usingDefaultData,
      label: usingDefaultData ? "默认样例数据" : "用户/缓存数据",
    };
  }, [commissionData.length, commissionLoaded, lastImportSummary, shippingData, shippingLoaded]);

  const operationalStatus = shippingData.length === 0 || commissionData.length === 0
    ? { label: "数据缺失", className: "bg-slate-100 text-slate-700 border-slate-300" }
    : shippingChannels.available.length === 0
      ? { label: "不可发", className: "bg-red-100 text-red-700 border-red-300" }
      : result.netProfit < 0 || result.adRiskControl?.isOverBudget
        ? { label: "高风险", className: "bg-red-100 text-red-700 border-red-300" }
        : result.warnings.length > 0 || result.isVolumetric
          ? { label: "有风险", className: "bg-amber-100 text-amber-700 border-amber-300" }
          : { label: "正常", className: "bg-emerald-100 text-emerald-700 border-emerald-300" };

  // 🔹 预计算渠道运费（仅可用渠道，不可用渠道按需计算）
  const channelCosts = useMemo(() => {
    const map = new Map<string, number>();
    // 🔴 优化：仅计算可用渠道的运费，不可用渠道不参与核心计算
    for (const ch of shippingChannels.available) {
      map.set(ch.id, calculateShippingCost(ch, input.weight, input.length, input.width, input.height, input.weight));
    }
    // 不可用渠道也计算（用于显示参考价格），但延迟到需要时
    for (const ch of shippingChannels.unavailable.slice(0, 20)) {
      map.set(ch.id, calculateShippingCost(ch, input.weight, input.length, input.width, input.height, input.weight));
    }
    return map;
  }, [shippingChannels.available, shippingChannels.unavailable, input.weight, input.length, input.width, input.height]);

  // 🔹 预计算所有渠道的计费模式信息
  const channelBillingInfo = useMemo(() => {
    const map = new Map<string, { 
      mode: string; 
      billingWeight: number; 
      actualWeight: number; 
      volumetricWeight: number; 
      isVolumetric: boolean; 
      divisor: number;
    }>();
    for (const ch of [...shippingChannels.available, ...shippingChannels.unavailable]) {
      const info = parseBillingWeight(ch, input.length, input.width, input.height, input.weight);
      map.set(ch.id, {
        mode: getBillingModeDescription(ch),
        billingWeight: info.billingWeight,
        actualWeight: info.actualWeight,
        volumetricWeight: info.volumetricWeight,
        isVolumetric: info.isVolumetric,
        divisor: info.divisor,
      });
    }
    return map;
  }, [shippingChannels.available, shippingChannels.unavailable, input.weight, input.length, input.width, input.height]);
  
  // 🔹 当前选中渠道的计费信息（用于输入面板计抛预警同步）
  const selectedBillingInfo = useMemo(() => {
    if (!selectedChannel) return null;
    return channelBillingInfo.get(selectedChannel.id) || null;
  }, [selectedChannel, channelBillingInfo]);

  const dimensionOrWeightExceeded = useMemo(() => {
    const sumDim = input.length + input.width + input.height;
    const maxSide = Math.max(input.length, input.width, input.height);
    const dimEx = shippingChannels.available.find(ch => (ch.maxLength && maxSide > ch.maxLength) || (ch.maxSumDimension && sumDim > ch.maxSumDimension));
    const weightEx = shippingChannels.available.find(ch => ch.maxWeight && input.weight > ch.maxWeight);
    return Boolean(dimEx || weightEx);
  }, [input.height, input.length, input.weight, input.width, shippingChannels.available]);

  const priceLimitAlertInfo = useMemo(() => {
    if (shippingChannels.available.length > 0) return null;

    const valueBlockedChannel = shippingChannels.unavailable.find(ch => ch.interceptionReasons?.some((reason) => reason.dimension === "货值"));
    const preferredCurrency = input.valueLimitCurrency;
    const preferredMin = preferredCurrency === "RMB" ? valueBlockedChannel?.minValue : valueBlockedChannel?.minValueRUB;
    const preferredMax = preferredCurrency === "RMB" ? valueBlockedChannel?.maxValue : valueBlockedChannel?.maxValueRUB;
    const fallbackCurrency = preferredCurrency === "RMB" ? "RUB" : "RMB";
    const fallbackMin = fallbackCurrency === "RMB" ? valueBlockedChannel?.minValue : valueBlockedChannel?.minValueRUB;
    const fallbackMax = fallbackCurrency === "RMB" ? valueBlockedChannel?.maxValue : valueBlockedChannel?.maxValueRUB;
    const hasPreferredLimit = preferredMin !== undefined || preferredMax !== undefined;
    const useRmbLimit = hasPreferredLimit ? preferredCurrency === "RMB" : fallbackCurrency === "RMB";
    const maxValue = hasPreferredLimit ? preferredMax : fallbackMax;
    const minValue = hasPreferredLimit ? preferredMin : fallbackMin;
    const currentValue = useRmbLimit ? input.targetPriceRMB : cnyToRub(input.targetPriceRMB, input.exchangeRate);
    const unit = useRmbLimit ? "¥" : "₽";
    const isPriceTooHigh = maxValue !== undefined && currentValue > maxValue;
    const isPriceTooLow = minValue !== undefined && currentValue < minValue;

    if (!valueBlockedChannel || (maxValue === undefined && minValue === undefined) || (!isPriceTooHigh && !isPriceTooLow)) {
      return null;
    }

    return {
      currentValue,
      isPriceTooHigh,
      isPriceTooLow,
      maxValue,
      minValue,
      unit,
      useRmbLimit,
    };
  }, [input.exchangeRate, input.targetPriceRMB, input.valueLimitCurrency, shippingChannels.available.length, shippingChannels.unavailable]);

  const rawTopAlerts = useMemo<TopAlertItem[]>(() => {
    const alerts: TopAlertItem[] = [];

    alerts.push({
      id: `operational-status-${operationalStatus.label}`,
      severity: operationalStatus.label === "正常" ? "success" : operationalStatus.label === "有风险" ? "warning" : "danger",
      label: (
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-current" />
          <span>{operationalStatus.label}</span>
        </span>
      ),
      plainText: `经营状态：${operationalStatus.label}`,
      action: (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setShowDiagnostic((open) => !open);
          }}
          className="ml-1 rounded bg-white/40 px-1.5 py-0.5 text-[10px] font-bold hover:bg-white/70"
        >
          查看诊断
        </button>
      ),
    });

    alerts.push({
      id: `sales-context-${input.valueLimitCurrency}-${input.fulfillmentMode || "RFBS"}-${input.targetPriceRMB}-${input.exchangeRate}`,
      severity: "info",
      label: (
        <>
          货值口径：{input.valueLimitCurrency === "RMB" ? "人民币" : "卢布"}
          <span className="mx-1 opacity-45">|</span>
          模式：{input.fulfillmentMode || "RFBS"}
          <span className="mx-1 opacity-45">|</span>
          售价：{cnyToRub(input.targetPriceRMB, input.exchangeRate).toFixed(0)} RUB
          <span className="mx-1 opacity-45">|</span>
          汇率：1 CNY = {input.exchangeRate.toFixed(2)} RUB
        </>
      ),
      plainText: `货值口径${input.valueLimitCurrency} 模式${input.fulfillmentMode || "RFBS"} 售价${cnyToRub(input.targetPriceRMB, input.exchangeRate).toFixed(0)}RUB 汇率${input.exchangeRate.toFixed(2)}`,
    });

    if (lastImportSummary) {
      const label = lastImportSummary.type === "shipping"
        ? `最近导入物流：${lastImportSummary.channels || 0} 条，人民币货值 ${lastImportSummary.valueRMBMapped || 0} 条，卢布货值 ${lastImportSummary.valueRUBMapped || 0} 条，时效 ${lastImportSummary.deliveryTimeMapped || 0} 条，体积重 ${lastImportSummary.volumetricMapped || 0} 条`
        : `最近导入佣金：${lastImportSummary.categories || 0} 个类目${lastImportSummary.commissionSheetName ? `，${lastImportSummary.commissionSheetName}` : ""}，RFBS ${lastImportSummary.commissionModeMapped?.RFBS || 0} 条，FBP ${lastImportSummary.commissionModeMapped?.FBP || 0} 条`;
      alerts.push({
        id: `last-import-${lastImportSummary.type}-${label}`,
        severity: "success",
        label: (
          <span className="inline-flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            <span>{label}</span>
          </span>
        ),
        plainText: label,
      });
    }

    const dataStatusText = `${dataStatus.label}，佣金 ${dataStatus.commissionCategories}，物流 ${dataStatus.shippingChannels}，货值覆盖 ${dataStatus.valueCoverage}%`;
    alerts.push({
      id: `data-status-${dataStatus.label}-${dataStatus.commissionCategories}-${dataStatus.shippingChannels}-${dataStatus.valueCoverage}`,
      severity: dataStatus.usingDefaultData ? "warning" : "info",
      label: (
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          <span>{dataStatusText}</span>
        </span>
      ),
      plainText: dataStatusText,
    });

    if (shippingChannels.available.length === 0 && shippingData.length > 0) {
      alerts.push({
        id: `fatal-no-shipping-${shippingChannels.unavailable.length}`,
        severity: "danger",
        label: "致命：无法匹配物流",
        plainText: `致命：无法匹配物流，${shippingChannels.unavailable.length} 条渠道不可用`,
        action: (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setShowDiagnostic((open) => !open);
            }}
            className="ml-1 rounded bg-white/25 px-1.5 py-0.5 text-[10px] font-bold hover:bg-white/40"
          >
            {showDiagnostic ? "隐藏" : "检查"}
          </button>
        ),
      });
    }

    if (priceSuggestion && priceSuggestion.suggestedPriceRMB > 0) {
      const priceSuggestionText = `建议售价 ¥${priceSuggestion.suggestedPriceRMB}，约 ${Math.round(priceSuggestion.suggestedPriceRUB).toLocaleString()} ₽，${priceSuggestion.targetMargin ? `可达 ${priceSuggestion.targetMargin}% 并匹配 ${priceSuggestion.channelName}` : `可匹配 ${priceSuggestion.channelName}`}${priceSuggestion.unfixableChannelCount > 0 ? `，另有 ${priceSuggestion.unfixableChannelCount} 个渠道调价无法修复` : ""}`;
      alerts.push({
        id: `price-suggestion-${Math.ceil(priceSuggestion.suggestedPriceRMB)}-${priceSuggestion.channelName}`,
        severity: "warning",
        label: (
          <>
            建议售价 <strong>¥{priceSuggestion.suggestedPriceRMB}</strong>
            <span className="ml-1">
              (≈{Math.round(priceSuggestion.suggestedPriceRUB).toLocaleString()}₽)
              {priceSuggestion.targetMargin ? ` 可达 ${priceSuggestion.targetMargin}% 并匹配「${priceSuggestion.channelName}」` : ` 可匹配「${priceSuggestion.channelName}」`}
            </span>
            {priceSuggestion.unfixableChannelCount > 0 && (
              <span className="ml-1 text-[10px] opacity-80">(另有{priceSuggestion.unfixableChannelCount}个渠道调价无法修复)</span>
            )}
          </>
        ),
        plainText: priceSuggestionText,
        action: (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setInput(prev => ({ ...prev, targetPriceRMB: priceSuggestion.suggestedPriceRMB }));
            }}
            className="ml-1 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-amber-600"
          >
            填入
          </button>
        ),
      });
    }

    if (priceSuggestion?.cannotFixByPrice) {
      alerts.push({
        id: "price-unfixable",
        severity: "danger",
        label: "所有渠道因尺寸/重量/属性拦截，调价无法解决",
        plainText: "所有渠道因尺寸重量属性拦截，调价无法解决",
      });
    }

    if (result.netProfit < 0) {
      alerts.push({
        id: "negative-profit",
        severity: "danger",
        label: `亏损: ¥${Math.abs(result.netProfit).toFixed(2)}`,
        plainText: `亏损 ${Math.abs(result.netProfit).toFixed(2)} 元`,
      });
    }

    if (dimensionOrWeightExceeded) {
      alerts.push({ id: "dimension-weight-exceeded", severity: "danger", label: "超限", plainText: "尺寸或重量超限" });
    }

    if (priceLimitAlertInfo) {
      const title = priceLimitAlertInfo.isPriceTooHigh && !priceLimitAlertInfo.isPriceTooLow
        ? "价格过高"
        : priceLimitAlertInfo.isPriceTooLow && !priceLimitAlertInfo.isPriceTooHigh
          ? "价格过低"
          : "价格不符";
      const formatLimit = (value: number) => priceLimitAlertInfo.useRmbLimit ? value.toFixed(2) : Math.round(value).toLocaleString();

      alerts.push({
        id: `price-limit-${title}-${priceLimitAlertInfo.unit}`,
        severity: "danger",
        label: title,
        plainText: `${title}：当前 ${priceLimitAlertInfo.unit}${formatLimit(priceLimitAlertInfo.currentValue)}，渠道要求 ${priceLimitAlertInfo.minValue !== undefined ? `${priceLimitAlertInfo.unit}${formatLimit(priceLimitAlertInfo.minValue)}` : "无下限"}${priceLimitAlertInfo.minValue !== undefined && priceLimitAlertInfo.maxValue !== undefined ? " 到 " : ""}${priceLimitAlertInfo.maxValue !== undefined ? `${priceLimitAlertInfo.unit}${formatLimit(priceLimitAlertInfo.maxValue)}` : "无上限"}`,
        detail: (
          <details className="group relative ml-1 inline">
            <summary className="inline cursor-help list-none text-xs opacity-75 hover:opacity-100">ⓘ</summary>
            <div className="hidden group-open:block fixed left-1/2 top-[92px] z-[99999] mt-2 min-w-[220px] -translate-x-1/2 whitespace-nowrap rounded-lg border-2 border-red-200 bg-white p-3 text-xs text-slate-700 shadow-xl">
              <div className="mb-1 font-bold text-red-600">渠道价格限制说明</div>
              <div className="text-[11px] text-slate-600">该物流渠道对商品售价有限制，您的售价超出了允许范围。</div>
              <div className="mt-2 space-y-1 rounded bg-red-50 p-2">
                <div className="flex justify-between gap-4 text-[11px]">
                  <span className="text-slate-500">您的售价:</span>
                  <span className="font-semibold text-red-600">{priceLimitAlertInfo.unit}{formatLimit(priceLimitAlertInfo.currentValue)}</span>
                </div>
                <div className="flex justify-between gap-4 text-[11px]">
                  <span className="text-slate-500">渠道要求:</span>
                  <span className="font-semibold">
                    {priceLimitAlertInfo.minValue !== undefined ? `${priceLimitAlertInfo.unit}${formatLimit(priceLimitAlertInfo.minValue)}` : "无下限"}
                    {priceLimitAlertInfo.minValue !== undefined && priceLimitAlertInfo.maxValue !== undefined ? " ~ " : ""}
                    {priceLimitAlertInfo.maxValue !== undefined ? `${priceLimitAlertInfo.unit}${formatLimit(priceLimitAlertInfo.maxValue)}` : "无上限"}
                  </span>
                </div>
              </div>
            </div>
          </details>
        ),
      });
    }

    if (selectedBillingInfo?.isVolumetric && selectedBillingInfo.billingWeight > selectedBillingInfo.actualWeight) {
      alerts.push({
        id: "volumetric-billing",
        severity: "warning",
        label: `计抛: ${selectedBillingInfo.billingWeight.toFixed(0)}g`,
        plainText: `计抛 ${selectedBillingInfo.billingWeight.toFixed(0)}g`,
      });
    }

    if (result.adRiskControl?.isOverBudget) {
      alerts.push({ id: "ad-over-budget", severity: "warning", label: "广告超支", plainText: "广告超支" });
    }

    if (input.profitWarningThreshold !== null && input.profitWarningThreshold !== undefined && isProfitMarginBelowThreshold(result.profitMargin, input.profitWarningThreshold)) {
      alerts.push({
        id: "profit-threshold",
        severity: "danger",
        label: `利润 ${result.profitMargin.toFixed(1)}% < 阈值 ${input.profitWarningThreshold}%`,
        plainText: `利润 ${result.profitMargin.toFixed(1)}% 低于阈值 ${input.profitWarningThreshold}%`,
      });
    }

    Array.from(new Set(result.suggestions.slice(0, 2))).forEach((suggestion, index) => {
      alerts.push({ id: `suggestion-${index}-${suggestion}`, severity: "info", label: suggestion, plainText: suggestion });
    });

    const weightSaved = (selectedBillingInfo?.volumetricWeight || 0) - input.weight;
    if (weightSaved > 50) {
      alerts.push({
        id: `weight-save-${Math.round(weightSaved)}`,
        severity: "success",
        label: `减重${weightSaved.toFixed(0)}g进下一阶梯`,
        plainText: `减重 ${weightSaved.toFixed(0)}g 进入下一阶梯`,
      });
    }

    if (alerts.length === 0 && !result.warnings.length && result.netProfit >= 0 && !selectedBillingInfo?.isVolumetric) {
      alerts.push({ id: "all-good", severity: "success", label: "参数正常", plainText: "参数正常" });
    }

    return alerts;
  }, [
    dataStatus.commissionCategories,
    dataStatus.label,
    dataStatus.shippingChannels,
    dataStatus.usingDefaultData,
    dataStatus.valueCoverage,
    dimensionOrWeightExceeded,
    input.exchangeRate,
    input.fulfillmentMode,
    input.profitWarningThreshold,
    input.targetPriceRMB,
    input.valueLimitCurrency,
    input.weight,
    lastImportSummary,
    operationalStatus.label,
    priceLimitAlertInfo,
    priceSuggestion,
    result.adRiskControl?.isOverBudget,
    result.netProfit,
    result.profitMargin,
    result.suggestions,
    result.warnings.length,
    selectedBillingInfo,
    shippingChannels.available.length,
    shippingChannels.unavailable.length,
    shippingData.length,
    showDiagnostic,
  ]);

  const activeTopAlertIdKey = useMemo(
    () => rawTopAlerts.map((item) => item.id).join("|"),
    [rawTopAlerts]
  );

  useEffect(() => {
    const activeIds = new Set(activeTopAlertIdKey ? activeTopAlertIdKey.split("|") : []);
    setDismissedAlertIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (activeIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [activeTopAlertIdKey]);

  const topAlerts = useMemo(
    () => rawTopAlerts.filter((item) => !dismissedAlertIds.has(item.id)),
    [dismissedAlertIds, rawTopAlerts]
  );

  const handleDismissTopAlert = useCallback((id: string) => {
    setDismissedAlertIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // 🔹 推荐物流排序：按费用/时效/评分排序
  const sortedAvailableChannels = useMemo(() => {
    const channels = [...shippingChannels.available];
    switch (sortMode) {
      case 'cost':
        // 按运费从低到高排序
        channels.sort((a, b) => {
          const costA = channelCosts.get(a.id) ?? Infinity;
          const costB = channelCosts.get(b.id) ?? Infinity;
          return costA - costB;
        });
        break;
      case 'time':
        // 按时效从快到慢排序（deliveryTime 越小越快）
        channels.sort((a, b) => a.deliveryTime - b.deliveryTime);
        break;
      case 'rating':
        // 按评分从高到低排序
        channels.sort((a, b) => (b.ozonRating || 0) - (a.ozonRating || 0));
        break;
    }
    return channels;
  }, [shippingChannels.available, sortMode, channelCosts]);

  // 🔹 不可用渠道排序：统一按名称排序
  const sortedUnavailableChannels = useMemo(() => {
    return [...shippingChannels.unavailable].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, [shippingChannels.unavailable]);

  const unavailableReasonSummary = useMemo(() => {
    const counts = new Map<string, number>();
    shippingChannels.unavailable.forEach((channel) => {
      const reason = (channel.reason || "未说明").split(/[，,。；;]/)[0]?.trim() || "未说明";
      counts.set(reason, (counts.get(reason) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => ({ reason, count }));
  }, [shippingChannels.unavailable]);

  const successfulBatchResults = useMemo(() => {
    const riskRank = { "高": 3, "中": 2, "低": 1 };
    const rows = batchResults.filter((item) => item.status === "success");
    return [...rows].sort((a, b) => {
      if (batchSortMode === "roi") return (b.roi ?? -Infinity) - (a.roi ?? -Infinity);
      if (batchSortMode === "risk") return riskRank[b.riskLevel] - riskRank[a.riskLevel];
      if (batchSortMode === "available") return b.availableChannelCount - a.availableChannelCount;
      if (batchSortMode === "volumetric") return Number(b.hasVolumetric) - Number(a.hasVolumetric);
      return (b.netProfit ?? -Infinity) - (a.netProfit ?? -Infinity);
    });
  }, [batchResults, batchSortMode]);

  const failedBatchResults = useMemo(
    () => batchResults.filter((item) => item.status === "failed"),
    [batchResults]
  );

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* 🔹 顶部控制台 - 极致扁平化 */}
      <header className="sticky top-0 z-[100] w-full bg-white/90 backdrop-blur-md border-b border-slate-200 shadow-sm h-11">
        {/* 外部容器 */}
        <div className="relative mx-auto flex h-full w-full max-w-[1480px] items-center justify-between px-3">
          {/* 左侧：品牌标题 */}
          <div className="flex-shrink-0">
            <span className="text-xs font-bold text-slate-600">🎯 精算</span>
          </div>
          
          {/* 右侧：功能聚合 - 扁平紧凑 */}
          <div className="ml-auto flex min-w-0 items-center gap-2 overflow-hidden pr-1 sm:overflow-visible">
            {/* 数据管理下拉菜单 */}
            <div className="relative">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setDataManagementOpen((open) => !open)}
                      className="flex h-7 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      aria-expanded={dataManagementOpen}
                    >
                      <Settings className="h-3 w-3" />
                      <span>数据</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent><p className="text-xs">数据管理</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {/* 下拉内容 */}
              {dataManagementOpen && (
              <div className="absolute top-full right-0 mt-1 bg-white border rounded shadow-lg z-50 min-w-[220px]">
                <div className="px-3 py-2 border-b text-xs font-medium text-slate-600">导入</div>
                <label className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer">
                  <Upload className="h-3 w-3 text-blue-600" />
                  <span>导入佣金表</span>
                  <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleCommissionFileUpload} />
                </label>
                <label className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer">
                  <Truck className="h-3 w-3 text-green-600" />
                  <span>导入物流表</span>
                  <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleShippingFileUpload} />
                </label>
                <label className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer">
                  <FileText className="h-3 w-3 text-purple-600" />
                  <span>{isBatchCalculating ? "批量计算中..." : "导入批量计算表"}</span>
                  <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleBatchFileUpload} disabled={isBatchCalculating} />
                </label>
                <button onClick={handleExportSingleReport} className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">
                  <FileText className="h-3 w-3 text-slate-600" />
                  导出单品报告
                </button>
                <div className="px-3 py-2 border-t text-xs font-medium text-slate-600">数据状态</div>
                <div className="px-3 py-2 text-[11px] text-slate-600 space-y-1 bg-slate-50">
                  <div className="flex justify-between gap-3"><span>口径</span><b>{dataStatus.label}</b></div>
                  <div className="flex justify-between gap-3"><span>佣金类目</span><b>{dataStatus.commissionCategories}</b></div>
                  <div className="flex justify-between gap-3"><span>物流渠道</span><b>{dataStatus.shippingChannels}</b></div>
                  <div className="flex justify-between gap-3"><span>货值覆盖</span><b>{dataStatus.valueCoverage}%</b></div>
                  <div className="flex justify-between gap-3"><span>字段缺失</span><b>{dataStatus.missingLogisticsFields}</b></div>
                </div>
                <div className="px-3 py-2 border-t border-b text-xs font-medium text-slate-600">模板</div>
                <button onClick={downloadCommissionTemplate} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">佣金表模板</button>
                <button onClick={downloadShippingTemplate} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">物流表模板</button>
                <button onClick={downloadBatchTemplate} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">批量计算模板</button>
                <div className="px-3 py-2 border-t text-xs font-medium text-slate-600">配置</div>
                <button onClick={() => exportConfig()} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">导出配置</button>
                <label className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 cursor-pointer">
                  <FileText className="h-3 w-3" />
                  <span>导入配置</span>
                  <input type="file" accept=".json" className="hidden" onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (evt) => {
                      try {
                        const config = JSON.parse(evt.target?.result as string);
                        if (config.input) {
                          localStorage.setItem("ozon-calculator-input", config.input);
                          window.location.reload();
                        }
                      } catch (err) { alert(`导入失败: ${err}`); }
                    };
                    reader.readAsText(file);
                  }} />
                </label>
              </div>
              )}
            </div>
            
            {/* 经营模式 - 平台佣金口径 */}
            <div className="hidden h-8 flex-shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 p-1 sm:flex">
              {(["RFBS", "FBP"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setInput((prev) => ({ ...prev, fulfillmentMode: mode }))}
                  className={`h-6 rounded px-2 text-[11px] font-bold transition-colors ${
                    (input.fulfillmentMode || "RFBS") === mode
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-500 hover:bg-white hover:text-slate-700"
                  }`}
                  title={`${mode} 佣金模式`}
                >
                  {mode}
                </button>
              ))}
            </div>
            
            {/* 汇率设置组 - 扁平紧凑 */}
            <div className="hidden h-8 flex-shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 sm:flex">
              <span className="text-[11px] text-slate-500 whitespace-nowrap">1 CNY =</span>
              <Input
                type="number"
                step="0.001"
                min="0.001"
                value={input.exchangeRate}
                onChange={(e) => {
                  setInput(prev => ({ ...prev, exchangeRate: parseFloat(e.target.value) || 12.0 }));
                  setRateFetchError(null);
                }}
                className="h-6 w-[70px] bg-white px-2 text-xs"
                aria-invalid={!!rateFetchError}
                aria-describedby="rate-error"
              />
              <span className="text-[10px] text-slate-400">₽</span>
              <Button 
                variant="ghost" 
                size="iconXs" 
                className="h-6 w-6 p-0" 
                onClick={fetchExchangeRate} 
                disabled={isFetchingRate} 
                title="获取汇率" 
                aria-label="刷新汇率"
              >
                <RefreshCw className={`h-3 w-3 ${isFetchingRate ? "animate-spin" : ""}`} />
              </Button>
              {/* 汇率错误提示 */}
              {rateFetchError ? (
                <span id="rate-error" className="text-[9px] text-red-500 whitespace-nowrap" role="alert">
                  ⚠️
                </span>
              ) : (
                /* 辅助提示：当前反向换算 */
                <div className="flex flex-col -space-y-0.5">
                  <span className="text-[9px] text-slate-400 whitespace-nowrap">1 RUB ≈ {(1/input.exchangeRate).toFixed(4)}¥</span>
                </div>
              )}
            </div>
            
            {/* 提现/支付手续费 - 扁平紧凑 */}
            <div className="hidden h-8 flex-shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 md:flex">
              <span className="text-[11px] text-slate-500 whitespace-nowrap">提现</span>
              <Input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={input.withdrawalFee}
                onChange={(e) => setInput(prev => ({ ...prev, withdrawalFee: parseFloat(e.target.value) || 0 }))}
                className="h-6 w-[50px] bg-white px-2 text-xs"
              />
              <span className="text-[10px] text-slate-400">%</span>
              <span className="ml-1 text-[11px] text-slate-500 whitespace-nowrap">支付</span>
              <Input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={input.paymentFee}
                onChange={(e) => setInput(prev => ({ ...prev, paymentFee: parseFloat(e.target.value) || 0 }))}
                className="h-6 w-[44px] bg-white px-2 text-xs"
              />
              <span className="text-[10px] text-slate-400">%</span>
            </div>
            
            {/* 重置按钮 */}
            <div className="hidden border-l border-slate-300 pl-2 sm:block">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="dangerSoft" size="iconXs" onClick={handleReset} className="p-0">
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent><p className="text-xs">重置全部</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </div>
      </header>
      
      {/* 🔹 上传成功/失败提示 - 浮动Toast */}
      {uploadToast && (
        <div className={`fixed top-14 right-4 z-[100] px-4 py-3 rounded-lg shadow-xl border-2 text-sm font-medium transition-all animate-slide-in ${
          uploadToast.type === 'success' 
            ? 'bg-emerald-50 text-emerald-800 border-emerald-300' 
            : 'bg-red-50 text-red-800 border-red-300'
        }`}>
          {uploadToast.message}
          <button onClick={() => setUploadToast(null)} className="ml-2 opacity-50 hover:opacity-100">✕</button>
        </div>
      )}
      
      {/* 🔹 全局诊断通栏 - 横跨全屏，自适应滚动，去重渲染 */}
      <div 
        id="global-diagnostic-bar"
        className="mx-auto flex h-9 w-full max-w-[1480px] items-center justify-start overflow-hidden border-b border-slate-200 bg-slate-50 px-3 py-1 md:justify-center"
        style={{ 
          minHeight: '36px',
          overflowY: 'hidden'
        }}
      >
        <TopAlertBar items={topAlerts} onDismiss={handleDismissTopAlert} />

        {showDiagnostic && (
          <>
            <div className="fixed inset-0 z-[70] bg-black/20" onClick={() => setShowDiagnostic(false)} />
            <div className="fixed left-1/2 top-[96px] z-[75] w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-700 shadow-2xl">
              <div className="mb-3 flex items-center justify-between">
                <div className="font-bold text-slate-800">经营状态诊断</div>
                <button onClick={() => setShowDiagnostic(false)} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">关闭</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded border bg-slate-50 p-2">
                  <div className="text-slate-500">可用物流</div>
                  <div className="mt-1 text-lg font-bold text-slate-800">{shippingChannels.available.length}</div>
                </div>
                <div className="rounded border bg-slate-50 p-2">
                  <div className="text-slate-500">不可用物流</div>
                  <div className="mt-1 text-lg font-bold text-slate-800">{shippingChannels.unavailable.length}</div>
                </div>
                <div className="rounded border bg-slate-50 p-2">
                  <div className="text-slate-500">当前净利</div>
                  <div className={`mt-1 text-lg font-bold ${getFinanceTextClass(result.netProfit)}`}>¥{result.netProfit.toFixed(2)}</div>
                </div>
                <div className="rounded border bg-slate-50 p-2">
                  <div className="text-slate-500">数据口径</div>
                  <div className="mt-1 text-sm font-bold text-slate-800">{dataStatus.label}</div>
                </div>
              </div>
              {shippingChannels.unavailable.length > 0 && (
                <div className="mt-3">
                  <div className="mb-2 font-semibold text-slate-700">拦截拆解</div>
                  <div className="grid grid-cols-7 gap-1">
                    {interceptionBreakdown.map((item) => (
                      <div key={item.dimension} className="rounded border bg-white p-1.5 text-center">
                        <div className="text-[10px] text-slate-500">{item.dimension}</div>
                        <div className={`mt-1 font-bold ${item.count > 0 ? "text-red-700" : "text-slate-400"}`}>{item.count}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-3 rounded bg-blue-50 p-2 text-blue-800">
                {result.netProfit < 0
                  ? "首要动作：先提高售价或降低采购/物流成本，恢复单件正利润。"
                  : selectedBillingInfo?.isVolumetric
                    ? "首要动作：当前触发计抛，优先优化包装尺寸。"
                    : "当前没有严重阻断，可继续做批量 SKU 对比或导出单品报告。"}
              </div>
            </div>
          </>
        )}

      </div>
      
      {/* 🔹 主内容区 - 四区紧凑经营工作台 */}
      <main className="mx-auto flex-1 w-full max-w-[1480px] overflow-y-auto px-3 py-2 xl:overflow-hidden">
        <section className="-mx-3 mb-2 flex min-h-14 flex-wrap items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
          {[
            { label: "净利", value: `¥${result.netProfit.toFixed(1)}`, className: getFinanceTextClass(result.netProfit), important: true },
            { label: "ROI", value: `${result.roi.toFixed(1)}%`, className: getFinanceTextClass(result.roi), important: true },
            { label: "利润率", value: `${result.profitMargin.toFixed(1)}%`, className: getFinanceTextClass(result.profitMargin), important: true },
            { label: "总成本", value: `¥${result.costs.total.toFixed(1)}`, className: "text-slate-800" },
            { label: "售价", value: `¥${input.targetPriceRMB.toFixed(0)}`, className: "text-indigo-700" },
            { label: "可发渠道", value: `${shippingChannels.available.length}/${shippingChannels.available.length + shippingChannels.unavailable.length}`, className: shippingChannels.available.length > 0 ? "text-emerald-700" : "text-red-700" },
          ].map((item) => (
            <div
              key={item.label}
              className={`flex h-11 items-center justify-center gap-2 rounded-lg border px-3 ${
                item.important
                  ? "min-w-[132px] border-slate-200 bg-slate-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]"
                  : "min-w-[104px] border-transparent bg-white"
              }`}
            >
              <span className="text-[11px] font-semibold text-slate-500">{item.label}</span>
              <span className={`${item.important ? "text-xl" : "text-base"} font-black leading-none tabular-nums ${item.className}`}>{item.value}</span>
            </div>
          ))}
        </section>

        <div className="-mx-3 grid h-auto grid-cols-1 gap-2 overflow-visible lg:grid-cols-[350px_minmax(500px,1fr)] xl:h-[calc(100vh-9.25rem)] xl:grid-cols-[350px_minmax(480px,1fr)_390px] xl:overflow-hidden">
          {/* 左侧输入区 */}
          {/* 🔹 重构：Flex 纵向锁定 - 父容器撑满高度，内部独立滚动 */}
          <div className="col-span-1 flex min-h-0 flex-col xl:h-full">
            {/* 🔹 上部：参数输入区 - 独立滚动区域 */}
            <div className="min-h-0 flex-1 overflow-y-auto pb-2 pr-1 scrollbar-thin">
              <InputPanel
                input={input}
                onInputChange={handleInputChange}
                rivalPrice={input.rivalPrice}
                rivalCurrency={input.rivalCurrency}
                currentProfitMargin={result.profitMargin}
                onReversePriceFromMargin={handleReversePriceFromMargin}
                marginError={marginError}
                adRiskControl={result.adRiskControl}
                shippingData={shippingData}
                selectedBillingInfo={selectedBillingInfo}
                lockedMargin={lockedMargin}
                onToggleMarginLock={handleToggleMarginLock}
                suggestedPriceInfo={priceSuggestion}
                onCopyOzonPrice={handleCopyOzonPrice}
              />
            </div>
          </div>

          {/* 中间财务看板 */}
          <div className="col-span-1 min-h-0 overflow-y-visible pr-1 scrollbar-thin xl:overflow-y-auto">
            <Dashboard
              result={result}
              input={input}
              rivalPrice={input.rivalPrice}
              rivalCurrency={input.rivalCurrency}
              profitWarningThreshold={input.profitWarningThreshold}
              shippingChannels={shippingChannels}
              allShippingChannels={shippingData}
              selectedChannel={selectedChannel}
              onSelectChannel={handleSelectChannel}
              profitCurve={profitCurve}
              stressTest={stressTest}
              multiItemProfit={multiItemProfit}
              sixTierPricing={sixTierPricing}
              commission={commission}
              onCopyOzonPrice={handleCopyOzonPrice}
            />
          </div>

          {/* 右侧物流列表 */}
          <div className="col-span-1 flex min-h-0 flex-col gap-2 overflow-visible xl:h-full xl:overflow-hidden">
            {/* 物流筛选区 */}
            <div className="rounded-lg border bg-card p-2">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Truck className="h-4 w-4" />
                  物流渠道
                </h3>
                <span className="text-[10px] text-muted-foreground">
                  可用 {shippingChannels.available.length} / 总计 {shippingChannels.available.length + shippingChannels.unavailable.length}
                </span>
              </div>
              {/* 物流多选筛选 */}
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="segmented"
                  data-active={(input.designatedProviders || []).length === 0}
                  onClick={() => handleInputChange({ ...input, designatedProviders: [] })}
                >
                  全部
                </Button>
                {/* 🔹 收藏夹筛选 */}
                {favoriteChannels.length > 0 && (
                  <Button
                    type="button"
                    size="xs"
                    variant="segmented"
                    data-active={(input.designatedProviders || []).includes("__favorites__")}
                    onClick={() => {
                      const current = input.designatedProviders || [];
                      const newProviders = current.includes("__favorites__")
                        ? current.filter(p => p !== "__favorites__")
                        : [...current.filter(p => p !== "__favorites__"), "__favorites__"];
                      handleInputChange({ ...input, designatedProviders: newProviders });
                    }}
                  >
                    <Star className="h-3 w-3" />
                    收藏
                  </Button>
                )}
                {[...new Set(shippingData.map(ch => ch.thirdParty).filter(Boolean))].sort().map(provider => (
                  <Button
                    key={provider}
                    type="button"
                    size="xs"
                    variant="segmented"
                    data-active={(input.designatedProviders || []).includes(provider)}
                    onClick={() => {
                      const current = input.designatedProviders || [];
                      const newProviders = current.includes(provider)
                        ? current.filter(p => p !== provider)
                        : [...current, provider];
                      handleInputChange({ ...input, designatedProviders: newProviders });
                    }}
                  >
                    {provider}
                  </Button>
                ))}
              </div>
              {/* 🔹 推荐排序切换 */}
              <div className="flex items-center gap-1 mt-2">
                <span className="text-[10px] text-slate-400 mr-1">推荐:</span>
                {[
                  { key: 'cost' as const, label: '费用', icon: WalletCards },
                  { key: 'time' as const, label: '时效', icon: Clock },
                  { key: 'rating' as const, label: '评分', icon: Star },
                ].map(({ key, label, icon: Icon }) => (
                  <Button
                    key={key}
                    type="button"
                    size="xs"
                    variant="segmented"
                    data-active={sortMode === key}
                    onClick={() => setSortMode(key)}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-1 mt-2">
                <span className="text-[10px] text-slate-400 mr-1">货值:</span>
                {[
                  { key: "RMB" as const, label: "人民币货值" },
                  { key: "RUB" as const, label: "卢布货值" },
                ].map(({ key, label }) => (
                  <Button
                    key={key}
                    type="button"
                    size="xs"
                    variant="segmented"
                    data-active={input.valueLimitCurrency === key}
                    onClick={() => handleInputChange({ ...input, valueLimitCurrency: key })}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
            
            {/* 🔹 唯一物流列表（唯一物流模块） */}
            {selectedChannel && (
              <div className="sticky top-0 z-10 overflow-hidden rounded-lg border-2 border-indigo-400 bg-gradient-to-r from-indigo-600 to-indigo-500 px-3 py-2 text-xs text-white shadow-lg shadow-indigo-200/70">
                <div className="absolute inset-y-0 left-0 w-1 bg-white/80" aria-hidden="true" />
                <div className="flex items-center justify-between gap-2 pl-1">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-black">
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-indigo-700">当前计算物流</span>
                      <span className="truncate">{selectedChannel.thirdParty || "Ozon"} / {selectedChannel.name}</span>
                    </div>
                    <div className="mt-1 truncate text-white/85">
                      费用 ¥{(channelCosts.get(selectedChannel.id) ?? 0).toFixed(2)}
                      {selectedBillingInfo?.isVolumetric ? ` · 计抛 ${selectedBillingInfo.billingWeight.toFixed(0)}g` : ` · 实重 ${selectedBillingInfo?.billingWeight?.toFixed(0) || input.weight}g`}
                    </div>
                  </div>
                  <div className="shrink-0 rounded-md bg-white/15 px-2 py-1 text-[10px] font-bold ring-1 ring-white/25">
                    已选中
                  </div>
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
              {/* 🔹 智能推荐提示 */}
              {(!input.designatedProviders || input.designatedProviders.length === 0) && shippingChannels.available.length > 0 && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-700">
                      根据您的商品属性，已为您
                      {sortMode === 'cost' ? '按费用推荐' : sortMode === 'time' ? '按时效推荐' : '按评分推荐'}
                      ，前 <strong>{Math.min(shippingChannels.available.length, 10)}</strong> 条渠道
                    </span>
                  </div>
                </div>
              )}
              
              {/* 可用渠道 - 高密度信息卡片 */}
              {sortedAvailableChannels.slice(0, showAllAvailable ? undefined : 10).map((channel) => {
                const cost = channelCosts.get(channel.id) ?? 0;
                const billing = channelBillingInfo.get(channel.id);
                const isSelected = selectedChannel?.id === channel.id;
                const hasVolumetricBilling = supportsVolumetricBilling(channel);
                const showVolumetricWarning = hasVolumetricBilling && billing?.isVolumetric;
                const divisor = billing?.divisor || 12000;
                
                return (
                  <LogisticsCard
                    key={channel.id}
                    channel={channel}
                    cost={cost}
                    billing={billing}
                    isSelected={isSelected}
                    onClick={() => handleSelectChannel(channel)}
                    input={input}
                  />
                );
              })}
              
              {/* 🔹 可用渠道查看更多/收起 */}
              {shippingChannels.available.length > 10 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  onClick={() => setShowAllAvailable(!showAllAvailable)}
                  className="w-full text-blue-600"
                >
                  {showAllAvailable ? (
                    <>收起渠道</>
                  ) : (
                    <>查看全部 {shippingChannels.available.length} 条可用渠道</>
                  )}
                </Button>
              )}
              
              {/* 不可用渠道（灰色卡片 + 红色拦截原因，下沉底部） */}
              {shippingChannels.unavailable.length > 0 && (
                <div className="mt-3 border-t border-dashed border-slate-300 pt-3">
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500">
                    <div className="flex items-center gap-2 font-semibold">
                    <AlertCircle className="h-4 w-4" />
                    不可用渠道 ({shippingChannels.unavailable.length})
                    </div>
                    {!showAllUnavailable && unavailableReasonSummary.length > 0 && (
                      <div className="flex min-w-0 flex-wrap justify-end gap-1">
                        {unavailableReasonSummary.map((item) => (
                          <span key={item.reason} className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                            {item.reason} {item.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    {showAllUnavailable && sortedUnavailableChannels.map((channel) => (
                      <div key={channel.id} className="rounded-lg border border-slate-200 bg-slate-100/60 p-2 opacity-70 transition-opacity hover:opacity-90">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-slate-600 truncate">
                              {channel.thirdParty} - {channel.name}
                            </div>
                          </div>
                        </div>
                        {/* 红色拦截原因 */}
                        <div className="flex items-start gap-2 bg-red-50 border border-red-100 p-2 rounded">
                          <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                          <span className="text-[10px] text-red-600 font-medium leading-relaxed">{channel.reason}</span>
                        </div>
                      </div>
                    ))}
                    {/* 🔹 不可用渠道查看更多/收起 */}
                    {shippingChannels.unavailable.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="compact"
                        onClick={() => setShowAllUnavailable(!showAllUnavailable)}
                        className="w-full text-slate-500"
                      >
                        {showAllUnavailable ? (
                          <>收起不可用渠道</>
                        ) : (
                          <>查看全部 {shippingChannels.unavailable.length} 条不可用渠道</>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {(batchResults.length > 0 || batchError) && (
        <div className="fixed bottom-4 left-4 z-[90] w-[720px] max-w-[calc(100vw-2rem)] max-h-[54vh] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <div className="text-sm font-bold text-slate-800">批量计算结果</div>
              <div className="text-[11px] text-slate-500">
                成功 {successfulBatchResults.length} 行 / 失败 {failedBatchResults.length + (batchError ? 1 : 0)} 项
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={batchSortMode}
                onChange={(event) => setBatchSortMode(event.target.value as BatchSortMode)}
                className="h-7 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600"
              >
                <option value="profit">按净利</option>
                <option value="roi">按 ROI</option>
                <option value="risk">按风险</option>
                <option value="available">按可发渠道</option>
                <option value="volumetric">按计抛</option>
              </select>
              <button
                type="button"
                onClick={handleExportBatchResults}
                className="rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
              >
                导出
              </button>
              <button
                type="button"
                onClick={handleClearBatchResults}
                className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
              >
                清空
              </button>
            </div>
          </div>
          <div className="max-h-[42vh] overflow-y-auto p-3 space-y-3">
            {batchError && (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 whitespace-pre-line">
                {batchError}
              </div>
            )}
            {successfulBatchResults.length > 0 && (
              <div>
                <div className="mb-2 text-[11px] font-semibold text-emerald-700">成功结果</div>
                <div className="overflow-x-auto rounded border border-slate-200">
                  <table className="min-w-[680px] w-full text-[11px]">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="p-2 text-left">行/SKU</th>
                        <th className="p-2 text-left">类目</th>
                        <th className="p-2 text-right">净利</th>
                        <th className="p-2 text-right">ROI</th>
                        <th className="p-2 text-right">利润率</th>
                        <th className="p-2 text-center">风险</th>
                        <th className="p-2 text-center">可发</th>
                        <th className="p-2 text-left">推荐物流</th>
                      </tr>
                    </thead>
                    <tbody>
                      {successfulBatchResults.slice(0, 20).map((item) => (
                        <tr key={`success-${item.rowIndex}`} className="border-t">
                          <td className="p-2 font-medium text-slate-700">#{item.rowIndex} {item.sku || ""}</td>
                          <td className="p-2 text-slate-600">{item.input.secondaryCategory}</td>
                          <td className={`p-2 text-right font-bold ${getFinanceTextClass(item.netProfit)}`}>¥{(item.netProfit ?? 0).toFixed(2)}</td>
                          <td className={`p-2 text-right font-semibold ${getFinanceTextClass(item.roi)}`}>{(item.roi ?? 0).toFixed(1)}%</td>
                          <td className={`p-2 text-right font-semibold ${getFinanceTextClass(item.profitMargin)}`}>{(item.profitMargin ?? 0).toFixed(1)}%</td>
                          <td className="p-2 text-center">
                            <span className={`rounded-full px-2 py-0.5 font-bold ${
                              item.riskLevel === "高" ? "bg-red-50 text-red-700" : item.riskLevel === "中" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
                            }`}>{item.riskLevel}</span>
                          </td>
                          <td className="p-2 text-center">{item.availableChannelCount}{item.hasVolumetric ? " / 计抛" : ""}</td>
                          <td className="p-2 text-slate-600 truncate max-w-[180px]">{item.selectedChannel?.thirdParty} / {item.selectedChannel?.name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {failedBatchResults.length > 0 && (
              <div>
                <div className="mb-2 text-[11px] font-semibold text-red-700">失败行</div>
                <div className="space-y-2">
                  {failedBatchResults.slice(0, 8).map((item) => (
                    <div key={`failed-${item.rowIndex}`} className="rounded border border-red-100 bg-red-50/70 px-3 py-2 text-[11px] text-red-700">
                      第 {item.rowIndex} 行{item.sku ? ` / ${item.sku}` : ""}：{item.errorReason}
                      {item.suggestedPriceRMB && (
                        <span className="ml-2 font-bold">建议售价 ≥ ¥{Math.ceil(item.suggestedPriceRMB)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* 🔹 CSV 列映射弹窗 */}
      {parsedCsvData && (
        <PreviewMappingDialog
          open={mappingDialogOpen}
          onOpenChange={(open) => {
            setMappingDialogOpen(open);
            if (!open) {
              setPendingMappingFile(null);
              setParsedCsvData(null);
            }
          }}
          parsedData={parsedCsvData}
          dataType={mappingDataType}
          onConfirm={handleMappingConfirm}
          onCancel={handleMappingCancel}
        />
      )}
    </div>
  );
}
