"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { InputPanel } from "@/components/input-panel";
import { Dashboard } from "@/components/dashboard";
import { LogisticsCard } from "@/components/logistics-card";
import { useDataHub } from "@/lib/data-hub-context";
import { RotateCcw, Truck, Upload, FileText, Settings, AlertCircle, RefreshCw } from "lucide-react";
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
import { CalculationInput, ShippingChannel, CalculationResult } from "@/lib/types";
import {
  performFullCalculation,
  calculateProfitCurve,
  calculateExchangeRateStressTest,
  calculateMultiItemProfit,
  getChargeableWeight,
  reversePriceFromMargin,
  calculateSixTierPricing,
  calculateSuggestedPrice,
} from "@/lib/calculator";
import { calculateShippingCost, parseBillingWeight, getBillingModeDescription } from "@/lib/data-hub-context";
import { PreviewMappingDialog } from "@/components/preview-mapping-dialog";
import { FieldMapping, ParsedData, smartParseCSV } from "@/lib/smart-parser";
import { cnyToRub, rubToCny } from "@/lib/currency";

// 默认输入：售价为 RMB（1500 RUB ÷ 12 = 125 RMB）
const DEFAULT_INPUT: CalculationInput = {
  primaryCategory: "电子产品",
  secondaryCategory: "电子产品配饰",
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
  cpcBid: 10,
  cpcConversionRate: 3,
  targetPriceRMB: 125, // RMB（≈1500 RUB）
  promotionDiscount: 0,
  exchangeRate: 12.0, // 1 CNY = 12 RUB
  withdrawalFee: 1.5,
  exchangeRateBuffer: 0, // 汇率安全缓冲：默认0%
  valueLimitCurrency: "RMB",
  rivalPrice: 0, // 竞品售价
  rivalCurrency: 'RMB' as const, // 竞品售价货币模式
  multiItemCount: 1, // 单单购买数量
  taxEnabled: false, // 税务核算默认关闭
  vatRate: 13, // 增值税率 13%
  corporateTaxRate: 25, // 企业所得税率 25%
};

// localStorage 键名
const STORAGE_KEY = "ozon-calculator-input";
const CONFIG_EXPORT_KEY = "ozon-calculator-config";

// 🔹 工具函数：检查渠道是否支持体积重计费
function supportsVolumetricBilling(channel: ShippingChannel): boolean {
  const billingType = (channel.billingType || "").toLowerCase();
  return billingType.includes("体积") || billingType.includes("取大") || billingType.includes("max");
}

// 🔹 工具函数：下载模板 CSV
function downloadTemplate(type: "commission" | "shipping" | "batch") {
  if (type === "batch") {
    // 批量计算模板
    const template = `SKU编号,一级类目,二级类目,长度(cm),宽度(cm),高度(cm),重量(g),采购成本(RMB),头程(RMB),包装(RMB),是否带电,是,是否带液体,是,目标售价(RMB),备注
SKU001,电子产品,手机配件,10,8,5,150,25,3,2,否,否,125,
SKU002,电子产品,充电器,5,5,3,80,10,1,否,否,50,`;
    const blob = new Blob([template], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ozon_batch_template.csv";
    link.click();
    URL.revokeObjectURL(url);
  } else if (type === "shipping") {
    const template = `配送方式,第三方物流,服务等级,固定费(RMB),续重费(RMB/g),最小重量(g),最大重量(g),最大长度(cm),最大宽度(cm),最大高度(cm),边长总和(cm),时效(天),计费类型,体积重除数
中国邮政小包,邮政,Economy,2.00,0.063,0,2000,60,60,60,150,25-35,取大,12000
顺丰国际,顺丰,Express,5.00,0.080,0,3000,60,60,60,120,10-15,取大,8000`;
    const blob = new Blob([template], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ozon_shipping_template.csv";
    link.click();
    URL.revokeObjectURL(url);
  } else {
    const template = `一级类目,二级类目,rfbs -> 0 - 1500 -> тариф, %,rfbs -> 1500.01 - 5000 -> тариф, %,rfbs -> 5000.01+ -> тариф, %
电子产品,手机配件,12,15,18
电子产品,充电器,12,15,18`;
    const blob = new Blob([template], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ozon_commission_template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
}

// 🔹 批量计算结果类型
interface BatchResultItem {
  sku: string;
  input: CalculationInput;
  channel: ShippingChannel;
  result: CalculationResult;
  profit: number;
  profitMargin: number;
}

// 🔹 批量计算解析函数
function parseBatchInput(csvContent: string): Partial<CalculationInput>[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(h => h.trim());
  const rows: Partial<CalculationInput>[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < headers.length) continue;
    
    const row: Partial<CalculationInput> = {};
    headers.forEach((header, idx) => {
      const value = values[idx]?.trim() || '';
      const key = header.toLowerCase();
      
      if (key.includes('sku') || key.includes('编号')) {
        // SKU 编号单独处理
      } else if (key.includes('长度')) {
        row.length = parseFloat(value) || 0;
      } else if (key.includes('宽度')) {
        row.width = parseFloat(value) || 0;
      } else if (key.includes('高度')) {
        row.height = parseFloat(value) || 0;
      } else if (key.includes('重量')) {
        row.weight = parseFloat(value) || 0;
      } else if (key.includes('采购')) {
        row.purchaseCost = parseFloat(value) || 0;
      } else if (key.includes('头程')) {
        row.domesticShipping = parseFloat(value) || 0;
      } else if (key.includes('包装')) {
        row.packagingFee = parseFloat(value) || 0;
      } else if (key.includes('带电')) {
        row.hasBattery = value === '是';
      } else if (key.includes('液体')) {
        row.hasLiquid = value === '是';
      } else if (key.includes('售价')) {
        row.targetPriceRMB = parseFloat(value) || 0;
      } else if (key.includes('一级')) {
        row.primaryCategory = value;
      } else if (key.includes('二级')) {
        row.secondaryCategory = value;
      }
    });
    
    if (row.primaryCategory || row.targetPriceRMB) {
      rows.push(row);
    }
  }
  
  return rows;
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
  const { getCommissionByCategory, getShippingChannels, shippingData, clearCommissionData, clearShippingData, loadCommissionData, loadShippingData, updateColumnMapping, updateInterceptionConfig } = useDataHub();
  const [input, setInput] = useState<CalculationInput>(DEFAULT_INPUT);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [marginError, setMarginError] = useState<string | null>(null);
  const [lockedChannelId, setLockedChannelId] = useState<string | null>(null); // 🔹 物流商锁定状态
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
        setInput({ ...DEFAULT_INPUT, ...parsedData, valueLimitCurrency: parsedData.valueLimitCurrency || "RMB" });
      }
      
      // 🔹 恢复锁定的物流商
      const savedLockedChannel = localStorage.getItem("ozon-locked-channel");
      if (savedLockedChannel) {
        setLockedChannelId(savedLockedChannel);
        setSelectedChannelId(savedLockedChannel);
      }

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
    () => getCommissionByCategory(input.primaryCategory, input.secondaryCategory),
    [input.primaryCategory, input.secondaryCategory]
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
    return calculateSuggestedPrice(shippingChannels.unavailable, effectiveRubPerCny, input.valueLimitCurrency);
  }, [shippingChannels, input.targetPriceRMB, input.weight, effectiveRubPerCny, input.valueLimitCurrency]);

  // 🔹 推荐物流排序：按费用/时效/评分排序（定义在 channelCosts 之后，见下方）

  // 默认选中价格最优渠道（如果已锁定，则使用锁定的渠道）
  const selectedChannel = useMemo(() => {
    // 🔹 优先使用锁定的物流商
    if (lockedChannelId) {
      const lockedChannel = shippingChannels.available.find((c) => c.id === lockedChannelId);
      if (lockedChannel) return lockedChannel;
    }
    
    if (selectedChannelId) {
      const ch = shippingChannels.available.find((c) => c.id === selectedChannelId);
      if (ch) return ch;
    }
    return shippingChannels.available[0] || null;
  }, [selectedChannelId, shippingChannels.available, lockedChannelId]);

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
    effectiveInput.cpcBid,
    effectiveInput.cpcConversionRate,
    effectiveInput.exchangeRate,
    effectiveInput.withdrawalFee,
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
    const cpcCost = effectiveInput.cpcEnabled && effectiveInput.cpcConversionRate > 0 ? rubToCny(effectiveInput.cpcBid / (effectiveInput.cpcConversionRate / 100), effectiveInput.exchangeRate) : 0;
    return {
      totalFixedCost: effectiveInput.purchaseCost + effectiveInput.domesticShipping + effectiveInput.packagingFee + internationalShipping + cpcCost + returnCost,
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
    const { totalFixedCost, cpaRateForM } = totalFixedCostData;
    return calculateProfitCurve(priceRangeRMB, effectiveInput.exchangeRate, commission, effectiveInput.withdrawalFee, cpaRateForM, totalFixedCost);
  }, [commission, effectiveInput, totalFixedCostData]);

  // 汇率抗压测试
  const stressTest = useMemo(() => {
    if (!commission) return { at5PercentDrop: 0, at10PercentDrop: 0, zeroProfitRate: 0 };
    const { totalFixedCost, cpaRateForM } = totalFixedCostData;
    return calculateExchangeRateStressTest(effectiveInput.targetPriceRMB, effectiveInput.exchangeRate, commission, effectiveInput.withdrawalFee, cpaRateForM, totalFixedCost);
  }, [commission, effectiveInput, totalFixedCostData]);

  // 多件装利润
  const multiItemProfit = useMemo(() => {
    if (!commission || !selectedChannel) return null;
    return calculateMultiItemProfit(effectiveInput.multiItemCount || 1, effectiveInput, selectedChannel, commission);
  }, [commission, effectiveInput, selectedChannel]);

  const handleSelectChannel = useCallback((channel: ShippingChannel) => {
    setSelectedChannelId(channel.id);
    // 🔹 点击即锁定：将选中的物流商设为锁定状态
    setLockedChannelId(channel.id);
    localStorage.setItem("ozon-locked-channel", channel.id);
  }, []);
  
  // 🔹 解锁/恢复自动匹配
  const handleUnlockChannel = useCallback(() => {
    setLockedChannelId(null);
    setSelectedChannelId(null);
    localStorage.removeItem("ozon-locked-channel");
  }, []);
  
  // 🔹 切换渠道收藏
  const handleToggleFavorite = useCallback((channelId: string) => {
    setFavoriteChannels(prev => {
      const newFavorites = prev.includes(channelId)
        ? prev.filter(id => id !== channelId)
        : [...prev, channelId];
      localStorage.setItem("ozon-favorite-channels", JSON.stringify(newFavorites));
      return newFavorites;
    });
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

  // 🔹 一键重置功能（彻底化：清除所有状态）
  // 🔹 全局重置函数：物理+逻辑+存储三重重置
  const handleReset = useCallback(() => {
    const confirmed = window.confirm(
      "⚠️ 确定要重置所有数据吗？\n\n" +
      "此操作将：\n" +
      "• 清空所有输入参数（尺寸、重量、成本等）\n" +
      "• 解除物流商锁定\n" +
      "• 清除所有缓存数据\n\n" +
      "此操作不可撤销！"
    );
    
    if (!confirmed) return;
    
    // ===== 1. 全局状态清空 =====
    setInput(DEFAULT_INPUT);
    setSelectedChannelId(null);
    setMarginError(null);
    setLockedChannelId(null);
    setLockedMargin(null);
    
    // ===== 2. 持久化存储清理 =====
    
    // 清除输入数据
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("ozon-locked-channel");
    localStorage.removeItem("ozon-locked-margin");
    
    // 清除数据中心缓存
    localStorage.removeItem("ozon_commission_data");
    localStorage.removeItem("ozon_shipping_data");
    localStorage.removeItem("ozon_commission_mappings");
    localStorage.removeItem("ozon_shipping_mappings");
    localStorage.removeItem("ozon_column_mapping");
    
    // 清除汇率缓存
    localStorage.removeItem("ozon_exchange_rate");
    localStorage.removeItem("ozon_withdrawal_fee");
    
    // 清除数据版本标记
    localStorage.removeItem("ozon_data_version");
    
    // ===== 3. 逻辑干预撤销 =====
    
    // 清除上传的佣金和物流数据
    if (clearCommissionData) clearCommissionData();
    if (clearShippingData) clearShippingData();
    
    // ===== 4. UI 刷新与防御 =====
    
    // 显示成功提示
    alert("✅ 重置成功！系统已恢复至初始状态。");
    
    // 强制刷新页面（确保所有组件重新挂载）
    window.location.reload();
    
  }, [clearCommissionData, clearShippingData]);

  // 🔹 佣金表上传处理
  const handleCommissionFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setCommissionFileName(file.name);
    
    try {
      // 读取文件并解析
      const content = await file.text();
      const parsed = smartParseCSV(content, "commission");
      setParsedCsvData(parsed);
      setMappingDataType("commission");
      setPendingMappingFile(file);
      setMappingDialogOpen(true);
    } catch (err) {
      // 回退到直接加载
      try {
        await loadCommissionData(file, "overwrite");
        setUploadToast({ message: `✅ 佣金表 "${file.name}" 导入成功！`, type: 'success' });
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
      const content = await file.text();
      const parsed = smartParseCSV(content, "shipping");
      setParsedCsvData(parsed);
      setMappingDataType("shipping");
      setPendingMappingFile(file);
      setMappingDialogOpen(true);
    } catch (err) {
      // 回退到直接加载
      try {
        await loadShippingData(file, "overwrite");
        setUploadToast({ message: `✅ 物流表 "${file.name}" 导入成功！`, type: 'success' });
      } catch (loadErr) {
        console.error("上传物流表失败:", loadErr);
        setUploadToast({ message: `❌ 物流表导入失败: ${loadErr instanceof Error ? loadErr.message : '未知错误'}`, type: 'error' });
      }
    }
  }, [loadShippingData]);
  
  // 🔹 映射确认处理
  const handleMappingConfirm = useCallback(async (mappings: FieldMapping[]) => {
    setMappingDialogOpen(false);
    
    if (pendingMappingFile) {
      try {
        if (mappingDataType === "commission") {
          await loadCommissionData(pendingMappingFile, "overwrite");
          setUploadToast({ message: `✅ 佣金表导入成功！`, type: 'success' });
        } else {
          const mappingRecord = Object.fromEntries(
            mappings.map((m) => [m.systemField, m.columnIndex])
          ) as Record<string, number>;
          updateColumnMapping("shipping", mappingRecord);
          await loadShippingData(pendingMappingFile, "overwrite", mappingRecord);
          setUploadToast({ message: `✅ 物流表导入成功！`, type: 'success' });
          
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

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* 🔹 顶部控制台 - 极致扁平化 */}
      <header className="sticky top-0 z-[100] w-full bg-white/80 backdrop-blur-md border-b border-slate-200 shadow-sm h-12">
        {/* 外部容器 */}
        <div className="w-full px-4 relative flex items-center justify-between h-full">
          {/* 左侧：品牌标题 */}
          <div className="flex-shrink-0">
            <span className="text-xs font-bold text-slate-600">🎯 精算</span>
          </div>
          
          {/* 中间：5个核心指标 - 绝对居中 - 醒目强化 - 小屏隐藏 */}
          <div className="hidden md:flex absolute left-1/2 -translate-x-1/2 items-center gap-4 whitespace-nowrap">
            {/* 净利 - 核心盈亏指标 */}
            <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-white shadow-sm border">
              <span className={`text-lg font-bold tabular-nums ${result.netProfit >= 0 ? "text-[#059669]" : "text-[#DC2626]"}`}>
                ¥{result.netProfit.toFixed(1)}
              </span>
              <span className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide">净利</span>
            </div>
            {/* ROI */}
            <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-white shadow-sm border">
              <span className={`text-lg font-bold tabular-nums ${result.roi >= 0 ? "text-[#059669]" : "text-[#DC2626]"}`}>
                {result.roi.toFixed(1)}%
              </span>
              <span className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide">ROI</span>
            </div>
            {/* 毛利率 */}
            <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-white shadow-sm border">
              <span className={`text-lg font-bold tabular-nums ${result.profitMargin >= 0 ? "text-[#059669]" : "text-[#DC2626]"}`}>
                {result.profitMargin.toFixed(1)}%
              </span>
              <span className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide">毛利率</span>
            </div>
            {/* 总成本 */}
            <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-white shadow-sm border">
              <span className="text-lg font-bold tabular-nums text-slate-700">
                ¥{result.costs.total.toFixed(1)}
              </span>
              <span className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide">成本</span>
            </div>
            {/* 售价 */}
            <div className="flex flex-col items-center px-3 py-1 rounded-lg bg-indigo-50 shadow-sm border border-indigo-200 whitespace-nowrap">
              <span className="text-lg font-bold tabular-nums text-[#4F46E5]">
                ¥{input.targetPriceRMB.toFixed(0)}
              </span>
              <span className="text-[9px] text-indigo-500 font-semibold uppercase tracking-wide">≈ {Math.round(cnyToRub(input.targetPriceRMB, input.exchangeRate)).toLocaleString()} ₽</span>
            </div>
          </div>
          
          {/* 右侧：功能聚合 - 扁平紧凑 */}
          <div className="flex items-center gap-2 w-auto flex-shrink-0 pr-2 ml-auto">
            {/* 数据管理下拉菜单 */}
            <div className="relative group">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button className="flex items-center justify-center h-7 px-2 rounded border border-gray-300 hover:bg-gray-50 text-xs gap-1">
                      <Settings className="h-3 w-3" />
                      <span>数据</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent><p className="text-xs">数据管理</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {/* 下拉内容 */}
              <div className="absolute top-full right-0 mt-1 bg-white border rounded shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 min-w-[140px]">
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
                <div className="px-3 py-2 border-t border-b text-xs font-medium text-slate-600">模板</div>
                <button onClick={() => downloadTemplate("commission")} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">佣金表模板</button>
                <button onClick={() => downloadTemplate("shipping")} className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50">物流表模板</button>
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
            </div>
            
            {/* 汇率设置组 - 扁平紧凑 */}
            <div className="flex items-center gap-1 bg-slate-100 rounded px-2 h-8 flex-shrink-0">
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
                className="w-[70px] h-6 text-xs bg-white px-2"
                aria-invalid={!!rateFetchError}
                aria-describedby="rate-error"
              />
              <span className="text-[10px] text-slate-400">₽</span>
              <Button 
                variant="ghost" 
                size="sm" 
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
            
            {/* 提现手续费 - 扁平紧凑 */}
            <div className="flex items-center gap-1 bg-slate-100 rounded px-2 h-8 flex-shrink-0">
              <span className="text-[11px] text-slate-500 whitespace-nowrap">提现</span>
              <Input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={input.withdrawalFee}
                onChange={(e) => setInput(prev => ({ ...prev, withdrawalFee: parseFloat(e.target.value) || 0 }))}
                className="w-[50px] h-6 text-xs bg-white px-2"
              />
              <span className="text-[10px] text-slate-400">%</span>
            </div>
            
            {/* 重置按钮 */}
            <div className="border-l border-slate-300 pl-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" onClick={handleReset} className="h-7 w-7 p-0 text-red-600 border-red-300 hover:bg-red-50">
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
        className="w-full flex flex-wrap justify-center items-center gap-2 px-4 py-2 bg-gradient-to-r from-slate-50 via-amber-50 to-slate-50 border-b border-amber-200"
        style={{ 
          minHeight: '40px',
          maxHeight: '100px',
          overflowY: 'auto'
        }}
      >
        {/* 🔴 致命错误 - 无可用渠道（唯一）- 强烈警报 */}
        {shippingChannels.available.length === 0 && shippingData.length > 0 && (
          <div className="flex-shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-full text-base font-extrabold bg-red-600 text-white border-4 border-red-800 shadow-2xl animate-critical-flash">
            <AlertCircle className="h-5 w-5" />
            <span>🚨 致命：商品尺寸/重量/属性无法匹配任何物流渠道</span>
            <button 
              type="button"
              onClick={() => setShowDiagnostic(!showDiagnostic)}
              className="ml-1 px-2 py-0.5 bg-white/20 hover:bg-white/30 rounded text-xs font-bold"
            >
              {showDiagnostic ? '隐藏' : '[检查]'}
            </button>
            {showDiagnostic && (
              <>
                <div 
                  className="fixed inset-0 z-[70] bg-black/30" 
                  onClick={() => setShowDiagnostic(false)}
                />
                <div 
                  className="fixed z-[75] p-4 bg-white text-slate-700 rounded-lg shadow-2xl border-2 border-red-200 text-xs whitespace-nowrap min-w-[320px] max-h-[450px] overflow-y-auto"
                  style={{ left: '50%', top: '100px', transform: 'translateX(-50%)' }}
                >
                <div className="flex items-center justify-between mb-2">
                  <div className="font-bold text-red-600">🔍 问题诊断与解决方案</div>
                  <button 
                    onClick={() => setShowDiagnostic(false)}
                    className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                  >
                    ✕ 关闭
                  </button>
                </div>
                
                {/* 检查输入是否完整 */}
                <div className="mb-3 bg-slate-50 p-2 rounded">
                  <div className="font-medium text-slate-700 mb-2">📝 输入检查：</div>
                  
                  {/* 尺寸 */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className={input.length > 0 && input.width > 0 && input.height > 0 ? "text-green-600" : "text-red-600"}>
                      {input.length > 0 && input.width > 0 && input.height > 0 ? "✓" : "✗"} 尺寸
                    </span>
                    {input.length > 0 && input.width > 0 && input.height > 0 && (
                      <span className="text-slate-500 text-[10px]">{input.length}×{input.width}×{input.height}cm</span>
                    )}
                  </div>
                  
                  {/* 重量 */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className={input.weight > 0 ? "text-green-600" : "text-red-600"}>
                      {input.weight > 0 ? "✓" : "✗"} 重量
                    </span>
                    {input.weight > 0 && (
                      <span className="text-slate-500 text-[10px]">{input.weight}g</span>
                    )}
                  </div>
                  
                  {/* 售价 */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className={input.targetPriceRMB > 0 ? "text-green-600" : "text-orange-600"}>
                      {input.targetPriceRMB > 0 ? "✓" : "?-"} 售价
                    </span>
                    {input.targetPriceRMB > 0 && (
                      <span className="text-slate-500 text-[10px]">¥{input.targetPriceRMB}</span>
                    )}
                  </div>
                  
                  {/* 属性 */}
                  <div className="flex items-center gap-2">
                    <span className={input.hasBattery || input.hasLiquid ? "text-orange-600" : "text-green-600"}>
                      {input.hasBattery || input.hasLiquid ? "⚠" : "✓"} 属性
                    </span>
                    <span className="text-slate-500 text-[10px]">
                      {input.hasBattery && "带电"}{input.hasBattery && input.hasLiquid && "/"}{input.hasLiquid && "带液"}
                      {!input.hasBattery && !input.hasLiquid && "普通"}
                    </span>
                  </div>
                </div>
                
                {/* 分析结果和建议 */}
                <div className="mb-3">
                  <div className="font-medium text-slate-700 mb-1">💡 建议：</div>
                  
                  {/* 如果缺少尺寸或重量 */}
                  {((input.length <= 0 || input.width <= 0 || input.height <= 0) || input.weight <= 0) && (
                    <div className="text-orange-600 ml-2 mb-2">
                      • 请填写完整的尺寸和重量信息
                    </div>
                  )}
                  
                  {/* 如果填写了尺寸重量��没有售价 - 显示价格建议 */}
                  {/* 🔴 智能售价建议：区分可修复/不可修复渠道 */}
                  {input.length > 0 && input.width > 0 && input.height > 0 && input.weight > 0 && input.targetPriceRMB <= 0 && shippingChannels.unavailable.length > 0 && (() => {
                    const suggestion = calculateSuggestedPrice(shippingChannels.unavailable, effectiveRubPerCny, input.valueLimitCurrency);
                    if (suggestion.fixableChannels.length > 0) {
                      return (
                        <div className="bg-amber-50 p-2 rounded mb-2">
                          <div className="text-amber-700 font-medium mb-1">💰 调整售价可匹配以下渠道：</div>
                          {suggestion.fixableChannels.slice(0, 5).map((opt, idx) => (
                            <div key={idx} className="flex justify-between items-center text-[10px] mb-1">
                              <span className="text-slate-600">{opt.channelName}</span>
                              <span className="font-semibold text-amber-700">
                                ≥ ¥{Math.ceil(opt.minPriceRMB)} (≈{Math.round(opt.minValueRUB).toLocaleString()}₽)
                              </span>
                            </div>
                          ))}
                          {suggestion.unfixableChannelCount > 0 && (
                            <div className="text-orange-600 text-[10px] mt-1 border-t border-amber-200 pt-1">
                              ⚠️ 另有 {suggestion.unfixableChannelCount} 个渠道因尺寸/重量/属性无法匹配，调价无法解决
                            </div>
                          )}
                        </div>
                      );
                    }
                    if (suggestion.cannotFixByPrice) {
                      return (
                        <div className="bg-red-50 p-2 rounded mb-2">
                          <div className="text-red-700 font-medium">⚠️ 调价无法解决</div>
                          <div className="text-red-600 text-[10px]">
                            所有渠道均因尺寸/重量/属性等原因无法匹配，仅调整售价无法解决。
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}
                  
                  {/* 如果尺寸重量售价都填了但还是没有渠道 - 显示具体原因 */}
                  {input.length > 0 && input.width > 0 && input.height > 0 && input.weight > 0 && input.targetPriceRMB > 0 && shippingChannels.unavailable.length > 0 && (
                    <div className="bg-red-50 p-2 rounded">
                      <div className="text-red-700 font-medium mb-1">⚠️ 被拦截原因：</div>
                      {shippingChannels.unavailable.slice(0, 2).map((ch, idx) => (
                        <div key={idx} className="text-slate-600 text-[10px] mb-1">
                          {ch.name}: {ch.reason || "不符合渠道要求"}
                        </div>
                      ))}
                      {shippingChannels.unavailable.length > 2 && (
                        <div className="text-slate-400 text-[9px]">
                          ...还有 {shippingChannels.unavailable.length - 2} 个渠道
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 如果是属性问题 */}
                  {(input.hasBattery || input.hasLiquid) && (
                    <div className="text-orange-600 ml-2 mb-2">
                      • 您的商品带有特殊属性（带电/带液），请确保选择支持该属性的物流渠道
                    </div>
                  )}
                </div>
                
                {/* 通用建议 */}
                <div className="mt-2 pt-2 border-t border-slate-200 text-slate-500 text-[10px]">
                  <div>• 尝试调整参数后重新计算</div>
                  <div>• 或更换其他物流渠道</div>
                </div>
              </div>
              </>
            )}
          </div>
        )}
        
        {/* 💡 智能售价建议横幅 - 无渠道+未填售价时显示 */}
        {priceSuggestion && priceSuggestion.suggestedPriceRMB > 0 && (
          <div className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-full text-base font-bold bg-amber-100 text-amber-800 border-2 border-amber-400 shadow-lg">
            <span>💡</span>
            <span>建议售价 <strong>¥{Math.ceil(priceSuggestion.suggestedPriceRMB)}</strong> 
              (≈{Math.round(priceSuggestion.suggestedPriceRUB).toLocaleString()}₽) 
              可匹配「{priceSuggestion.channelName}」</span>
            <button 
              onClick={() => setInput(prev => ({ ...prev, targetPriceRMB: Math.ceil(priceSuggestion.suggestedPriceRMB) }))}
              className="ml-1 px-2 py-0.5 bg-amber-500 hover:bg-amber-600 text-white rounded text-xs font-bold"
            >
              填入
            </button>
            {priceSuggestion.unfixableChannelCount > 0 && (
              <span className="text-[10px] text-amber-600 ml-1">
                (另有{priceSuggestion.unfixableChannelCount}个渠道调价无法修复)
              </span>
            )}
          </div>
        )}
        
        {/* 💡 调价无法解决横幅 */}
        {priceSuggestion && priceSuggestion.cannotFixByPrice && (
          <div className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold bg-red-100 text-red-800 border-2 border-red-400 shadow-lg">
            <span>⚠️</span>
            <span>所有渠道因尺寸/重量/属性拦截，调价无法解决</span>
          </div>
        )}
        
        {/* 🔴 阻断错误 - 亏损（唯一）- 强烈红色闪烁 */}
        {result.netProfit < 0 && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-full text-base font-extrabold bg-red-500 text-white border-3 border-red-700 shadow-xl animate-urgent-pulse">
            <span className="text-xl">❌</span>
            <span>亏损: ¥{Math.abs(result.netProfit).toFixed(2)}</span>
          </span>
        )}
        
        {/* 尺寸/重量超限（唯一）- 红色边框脉冲 */}
        {(() => {
          const sumDim = input.length + input.width + input.height;
          const maxSide = Math.max(input.length, input.width, input.height);
          const dimEx = shippingChannels.available.find(ch => (ch.maxLength && maxSide > ch.maxLength) || (ch.maxSumDimension && sumDim > ch.maxSumDimension));
          const weightEx = shippingChannels.available.find(ch => ch.maxWeight && input.weight > ch.maxWeight);
          if (dimEx || weightEx) {
            return (
              <span className="flex-shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-full text-base font-bold bg-red-100 text-red-700 border-3 border-red-400 animate-urgent-pulse">
                <span className="text-lg">⚠️</span>
                <span>超限</span>
              </span>
            );
          }
          return null;
        })()}
        
        {/* 🔹 渠道价格限制 - 仅当没有可用渠道时才显示警告 */}
        {(() => {
          // 只有当没有任何可用渠道时，才显示价格限制警告
          const hasAvailableChannels = shippingChannels.available.length > 0;
          
          // 如果有可用渠道，不显示价格拦截警告
          if (hasAvailableChannels) return null;
          
          // 提取价格限制的渠道，获取其数值范围
          const valueBlockedChannel = shippingChannels.unavailable.find(ch => ch.reason?.includes('货值') || ch.reason?.includes('价'));
          const preferredCurrency = input.valueLimitCurrency;
          const preferredMin = preferredCurrency === "RMB" ? valueBlockedChannel?.minValue : valueBlockedChannel?.minValueRUB;
          const preferredMax = preferredCurrency === "RMB" ? valueBlockedChannel?.maxValue : valueBlockedChannel?.maxValueRUB;
          const fallbackCurrency = preferredCurrency === "RMB" ? "RUB" : "RMB";
          const fallbackMin = fallbackCurrency === "RMB" ? valueBlockedChannel?.minValue : valueBlockedChannel?.minValueRUB;
          const fallbackMax = fallbackCurrency === "RMB" ? valueBlockedChannel?.maxValue : valueBlockedChannel?.maxValueRUB;
          const useRmbLimit = preferredMin !== undefined || preferredMax !== undefined
            ? preferredCurrency === "RMB"
            : fallbackCurrency === "RMB";
          const maxValue = preferredMin !== undefined || preferredMax !== undefined ? preferredMax : fallbackMax;
          const minValue = preferredMin !== undefined || preferredMax !== undefined ? preferredMin : fallbackMin;
          const currentValue = useRmbLimit ? input.targetPriceRMB : cnyToRub(input.targetPriceRMB, input.exchangeRate);
          const unit = useRmbLimit ? "¥" : "₽";
          
          // 判断是价格过高还是过低
          const isPriceTooHigh = maxValue !== undefined && currentValue > maxValue;
          const isPriceTooLow = minValue !== undefined && currentValue < minValue;
          
          return (valueBlockedChannel && (maxValue !== undefined || minValue !== undefined)) ? (
            <span className="flex-shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-full text-base font-bold bg-red-500 text-white border-3 border-red-600 shadow-lg animate-urgent-pulse">
              <span>❌</span>
              <span>{isPriceTooHigh && !isPriceTooLow ? '价格过高' : isPriceTooLow && !isPriceTooHigh ? '价格过低' : '价格不符'}</span>
              <details className="inline ml-1 group relative">
                <summary className="cursor-help list-none inline text-xs opacity-75 hover:opacity-100">
                  ⓘ
                </summary>
                <div className="hidden group-open:block fixed left-1/2 -translate-x-1/2 top-full z-[99999] mt-2 p-3 bg-white text-slate-700 rounded-lg shadow-xl border-2 border-red-200 text-xs whitespace-nowrap min-w-[200px]">
                  <div className="font-bold text-red-600 mb-1">📦 渠道价格限制说明</div>
                  <div className="text-slate-600 text-[11px]">
                    该物流渠道对商品售价有限制，您的售价超出了允许范围。
                  </div>
                  <div className="mt-2 bg-red-50 p-2 rounded space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-500">您的售价:</span>
                      <span className="font-semibold text-red-600">
                        {unit}{useRmbLimit ? currentValue.toFixed(2) : Math.round(currentValue).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-500">渠道要求:</span>
                      <span className="font-semibold">
                        {minValue !== undefined ? `${unit}${useRmbLimit ? minValue.toFixed(2) : Math.round(minValue).toLocaleString()}` : '无下限'}
                        {minValue !== undefined && maxValue !== undefined ? ' ~ ' : ''}
                        {maxValue !== undefined ? `${unit}${useRmbLimit ? maxValue.toFixed(2) : Math.round(maxValue).toLocaleString()}` : '无上限'}
                      </span>
                    </div>
                  </div>
                  <div className="mt-2 text-slate-500 text-[10px] border-t pt-2">
                    💡 <span className="font-medium">解决方法：</span>
                    <div>• 调整售价至允许范围内</div>
                    <div>• 或更换其他物流渠道</div>
                  </div>
                </div>
              </details>
            </span>
          ) : null;
        })()}
        
        {/* ⚠️ 计抛预警 - 强烈橙色脉冲（唯一） */}
        {selectedBillingInfo?.isVolumetric && selectedBillingInfo.billingWeight > selectedBillingInfo.actualWeight && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-full text-base font-extrabold bg-amber-500 text-white border-3 border-amber-600 shadow-xl animate-warning-pulse">
            <span className="text-lg">⚠️</span>
            <span>计抛: {selectedBillingInfo.billingWeight.toFixed(0)}g</span>
          </span>
        )}
        
        {/* 广告超支 - 橙色警告 */}
        {result.adRiskControl?.isOverBudget && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-full text-base font-bold bg-amber-100 text-amber-800 border-3 border-amber-400 shadow-lg animate-warning-pulse">
            <span className="text-lg">⚠️</span>
            <span>广告超支</span>
          </span>
        )}
        
        {/* 🔹 利润预警 - 低于阈值时显示 */}
        {input.profitWarningThreshold !== null && input.profitWarningThreshold !== undefined && result.profitMargin < input.profitWarningThreshold && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-full text-base font-bold bg-red-100 text-red-800 border-3 border-red-400 shadow-lg animate-warning-pulse">
            <span className="text-lg">⚠️</span>
            <span>利润 {result.profitMargin.toFixed(1)}% &lt; 阈值 {input.profitWarningThreshold}%</span>
          </span>
        )}
        
        {/* 💡 建议 Tips - 紫色提示（唯一） */}
        {(() => {
          const uniqueSuggestions = Array.from(new Set(result.suggestions.slice(0, 2)));
          return uniqueSuggestions.map((s, i) => (
            <span key={`tip-${i}`} className="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium bg-indigo-50 text-indigo-700 border-2 border-indigo-200">
              <span>💡</span>
              <span className="whitespace-nowrap">{s}</span>
            </span>
          ));
        })()}
        
        {/* 减重建议 - 绿色（唯一） */}
        {(() => {
          const weightSaved = (selectedBillingInfo?.volumetricWeight || 0) - input.weight;
          if (weightSaved > 50) {
            return (
              <span className="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold bg-emerald-50 text-emerald-700 border-2 border-emerald-300">
                <span>💡</span>
                <span>减重{weightSaved.toFixed(0)}g进下一阶梯</span>
              </span>
            );
          }
          return null;
        })()}
        
        {/* ✅ 参数正常提示（唯一） - 绿色醒目 */}
        {!result.warnings.length && result.netProfit >= 0 && !selectedBillingInfo?.isVolumetric && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold bg-emerald-50 text-emerald-700 border-2 border-emerald-300">
            <span>✅</span>
            <span>参数正常</span>
          </span>
        )}
      </div>
      
      {/* 🔹 主内容区 - 三栏布局 */}
      <main className="flex-1 container mx-auto px-4 py-3">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 h-[calc(100vh-5rem)]">
          {/* 左侧输入区 col-span-3 ≈ 25% */}
          {/* 🔹 重构：Flex 纵向锁定 - 父容器撑满高度，内部独立滚动 */}
          <div className="md:col-span-3 col-span-1 flex flex-col h-full">
            {/* 🔹 上部：参数输入区 - 独立滚动区域 */}
            <div className="flex-1 overflow-y-auto scrollbar-thin pb-3">
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
              />
            </div>
          </div>

          {/* 中间财务看板 col-span-5 ≈ 42% */}
          <div className="md:col-span-5 col-span-1 overflow-y-auto scrollbar-thin">
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
              lockedChannelId={lockedChannelId}
              onUnlockChannel={handleUnlockChannel}
              profitCurve={profitCurve}
              stressTest={stressTest}
              multiItemProfit={multiItemProfit}
              sixTierPricing={sixTierPricing}
              commission={commission}
            />
          </div>

          {/* 右侧物流列表 col-span-4 ≈ 33% */}
          <div className="md:col-span-4 col-span-1 flex flex-col gap-3 h-[calc(100vh-5rem)] overflow-hidden">
            {/* 物流筛选区 */}
            <div className="bg-card rounded-lg border p-3">
              <div className="flex items-center justify-between mb-2">
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
                <button
                  onClick={() => handleInputChange({ ...input, designatedProviders: [] })}
                  className={`px-2 py-1 rounded text-xs transition-all ${
                    (input.designatedProviders || []).length === 0 
                      ? "bg-blue-500 text-white" 
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  全部
                </button>
                {/* 🔹 收藏夹筛选 */}
                {favoriteChannels.length > 0 && (
                  <button
                    onClick={() => {
                      const current = input.designatedProviders || [];
                      const newProviders = current.includes("__favorites__")
                        ? current.filter(p => p !== "__favorites__")
                        : [...current.filter(p => p !== "__favorites__"), "__favorites__"];
                      handleInputChange({ ...input, designatedProviders: newProviders });
                    }}
                    className={`px-2 py-1 rounded text-xs transition-all ${
                      (input.designatedProviders || []).includes("__favorites__")
                        ? "bg-yellow-500 text-white" 
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    ⭐ 收藏
                  </button>
                )}
                {[...new Set(shippingData.map(ch => ch.thirdParty).filter(Boolean))].sort().map(provider => (
                  <button
                    key={provider}
                    onClick={() => {
                      const current = input.designatedProviders || [];
                      const newProviders = current.includes(provider)
                        ? current.filter(p => p !== provider)
                        : [...current, provider];
                      handleInputChange({ ...input, designatedProviders: newProviders });
                    }}
                    className={`px-2 py-1 rounded text-xs transition-all ${
                      (input.designatedProviders || []).includes(provider)
                        ? "bg-indigo-500 text-white" 
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    {provider}
                  </button>
                ))}
              </div>
              {/* 🔹 推荐排序切换 */}
              <div className="flex items-center gap-1 mt-2">
                <span className="text-[10px] text-slate-400 mr-1">推荐:</span>
                {[
                  { key: 'cost' as const, label: '按费用', icon: '💰' },
                  { key: 'time' as const, label: '按时效', icon: '⏱' },
                  { key: 'rating' as const, label: '按评分', icon: '⭐' },
                ].map(({ key, label, icon }) => (
                  <button
                    key={key}
                    onClick={() => setSortMode(key)}
                    className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                      sortMode === key
                        ? 'bg-blue-500 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    {icon} {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 mt-2">
                <span className="text-[10px] text-slate-400 mr-1">货值:</span>
                {[
                  { key: "RMB" as const, label: "人民币货值" },
                  { key: "RUB" as const, label: "卢布货值" },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => handleInputChange({ ...input, valueLimitCurrency: key })}
                    className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                      input.valueLimitCurrency === key
                        ? "bg-emerald-500 text-white shadow-sm"
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            
            {/* 🔹 唯一物流列表（唯一物流模块） */}
            <div className="flex-1 overflow-y-auto scrollbar-thin space-y-2">
              {/* 🔹 智能推荐提示 */}
              {!input.designatedProviders && shippingChannels.available.length > 0 && (
                <div className="bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200 rounded-lg p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-600">💡</span>
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
                    isFavorite={favoriteChannels.includes(channel.id)}
                    onToggleFavorite={handleToggleFavorite}
                  />
                );
              })}
              
              {/* 🔹 可用渠道查看更多/收起 */}
              {shippingChannels.available.length > 10 && (
                <button
                  onClick={() => setShowAllAvailable(!showAllAvailable)}
                  className="w-full py-2 text-xs text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors flex items-center justify-center gap-1"
                >
                  {showAllAvailable ? (
                    <>收起渠道</>
                  ) : (
                    <>查看全部 {shippingChannels.available.length} 条可用渠道</>
                  )}
                </button>
              )}
              
              {/* 不可用渠道（灰色卡片 + 红色拦截原因，下沉底部） */}
              {shippingChannels.unavailable.length > 0 && (
                <div className="mt-4 pt-4 border-t-2 border-dashed border-slate-300">
                  <div className="flex items-center gap-2 text-xs text-slate-500 font-semibold mb-3">
                    <AlertCircle className="h-4 w-4" />
                    不可用渠道 ({shippingChannels.unavailable.length})
                  </div>
                  <div className="space-y-2">
                    {sortedUnavailableChannels.slice(0, showAllUnavailable ? undefined : 5).map((channel) => (
                      <div key={channel.id} className="p-3 rounded-lg bg-slate-100/60 border border-slate-200 opacity-60 hover:opacity-80 transition-opacity">
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
                    {shippingChannels.unavailable.length > 5 && (
                      <button
                        onClick={() => setShowAllUnavailable(!showAllUnavailable)}
                        className="w-full py-2 text-xs text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors flex items-center justify-center gap-1"
                      >
                        {showAllUnavailable ? (
                          <>收起不可用渠道</>
                        ) : (
                          <>查看全部 {shippingChannels.unavailable.length} 条不可用渠道</>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
      
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
