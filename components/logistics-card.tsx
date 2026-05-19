"use client";

import { useCallback } from "react";
import { Battery, Droplets, Ruler, Scale, Star, Timer } from "lucide-react";
import { ShippingChannel, CalculationInput } from "@/lib/types";
import { CalculationTrace } from "./mapping-debug-panel";

interface LogisticsCardProps {
  channel: ShippingChannel;
  cost: number;
  billing: {
    mode: string;
    billingWeight: number;
    actualWeight: number;
    volumetricWeight: number;
    isVolumetric: boolean;
    divisor: number;
  } | undefined;
  isSelected: boolean;
  onClick: () => void;
  input: CalculationInput;
  // 🔹 收藏夹功能
  isFavorite?: boolean;
  onToggleFavorite?: (channelId: string) => void;
}

// 格式化函数
const fDim = (v: number | undefined | null): string => {
  if (v === undefined || v === null || v === Infinity) return '无限制';
  return `≤${v}`;
};

const hasRealLimitValue = (v: number | undefined | null): v is number => {
  return v !== undefined && v !== null && v !== Infinity && v < 999999;
};

const fPrice = (v: number | undefined | null, currency: "RMB" | "RUB"): string => {
  if (!hasRealLimitValue(v)) return "";
  return currency === "RMB" ? v.toFixed(2) : Math.round(v).toLocaleString();
};

export function LogisticsCard({ channel, cost, billing, isSelected, onClick, input, isFavorite = false, onToggleFavorite }: LogisticsCardProps) {
  // 🔹 收藏切换回调
  const handleToggleFavorite = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleFavorite) {
      onToggleFavorite(channel.id);
    }
  }, [channel.id, onToggleFavorite]);
  
  // 🔴 核心逻辑：直接使用计算引擎的结果，不做本地判定
  const isVolMetric = billing?.isVolumetric ?? false;
  const volWeight = billing?.volumetricWeight || 0;
  const actualWeight = billing?.actualWeight || 0;
  
  // 🔴 安全防护：如果抛重异常（超过 50kg），强制关闭标签
  const safetyCheck = volWeight < 50000;  // 50kg 安全阀
  const showVolumetricLabel = isVolMetric && safetyCheck;
  
  const isAvailable = true; // 默认可用，拦截原因在 unavailable 列表展示
  
  // 🔴 关键修复：直接使用 varFeePerGram（每克运费），不转换
  const varFeePerGram = channel.varFeePerGram;
  
  // 从 billing 获取计费数据
  const freightData = {
    total: cost,
    original: cost * 1.1, // 模拟原价
    billingWeight: billing?.billingWeight || 0,
    formula: billing 
      ? `¥${channel.fixFee.toFixed(2)} + (${billing.billingWeight}g × ¥${varFeePerGram.toFixed(4)})`
      : '计算中...'
  };

  // 从 channel 提取 limits 数据（兼容新旧数据结构）
  const valueLimitCurrency = input.valueLimitCurrency || "RMB";
  const limits = {
    minWt: channel.minWeight || 0,
    maxWt: channel.maxWeight || Infinity,
    maxSide: channel.maxLength || Infinity, // 近似最长边
    maxSum: channel.maxSumDimension || Infinity,
    minPrice: valueLimitCurrency === "RMB" ? channel.minValue : channel.minValueRUB,
    maxPrice: valueLimitCurrency === "RMB" ? channel.maxValue : channel.maxValueRUB,
    maxVolWt: billing?.divisor || 12000,
    allowBattery: channel.batteryAllowed !== false,
    allowLiquid: channel.liquidAllowed !== false,
  };
  const valueSymbol = valueLimitCurrency === "RMB" ? "¥" : "₽";
  const minValueLabel = hasRealLimitValue(limits.minPrice)
    ? `${valueSymbol}${fPrice(limits.minPrice, valueLimitCurrency)}`
    : "无下限";
  const maxValueLabel = hasRealLimitValue(limits.maxPrice)
    ? `${valueSymbol}${fPrice(limits.maxPrice, valueLimitCurrency)}`
    : "无上限";

  return (
    <div 
      onClick={onClick}
      className={`relative mb-1.5 cursor-pointer rounded-lg border p-2.5 transition-all ${
        !isAvailable 
          ? 'bg-secondary opacity-60 border-border' 
          : isSelected 
            ? 'bg-indigo-50/50 border-[#6366F1] shadow-md ring-1 ring-[#6366F1]/20' 
            : 'bg-card hover:shadow-md border-border'
      }`}
    >
      {/* 1. 顶部状态栏：时效 + 计抛强提醒 + Ozon 评级 */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            <Timer className="h-3 w-3" />
            {channel.deliveryTimeMin || 15}-{channel.deliveryTimeMax || 30} 天
          </span>
          {showVolumetricLabel && isAvailable && (
            <span className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">
              计抛
            </span>
          )}
          {/* Ozon 评级标签 */}
          {channel.ozonRating > 0 && (
            <div className="flex items-center gap-1 rounded border border-yellow-200 bg-yellow-50 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
              <Star className="h-3 w-3 fill-yellow-400 text-yellow-500" />
              {channel.ozonRating.toFixed(1)}
            </div>
          )}
        </div>
        {/* 🔹 收藏按钮 */}
        {onToggleFavorite && (
          <button
            onClick={handleToggleFavorite}
            className="absolute right-2 top-2 rounded-md p-1 hover:bg-secondary transition-colors"
            title={isFavorite ? "取消收藏" : "添加到收藏夹"}
          >
          <Star className={`h-3.5 w-3.5 ${isFavorite ? "fill-yellow-400 text-yellow-500" : "text-muted-foreground"}`} />
          </button>
        )}
        <div className="text-xs text-muted-foreground font-medium">
          评分组: {channel.serviceTier || '-'}
        </div>
      </div>

      {/* 2. 标题与价格区 */}
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold leading-tight text-foreground">
            {channel.name}
          </h3>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[10px] bg-indigo-50 text-[#6366F1] px-1.5 py-0.5 rounded border border-indigo-100">
              {channel.serviceLevel || '标准服务'}
            </span>
            <span className="text-[10px] text-muted-foreground">{channel.thirdParty || 'Ozon网络'}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold leading-5 text-[#6366F1]">
            ¥ {freightData.total.toFixed(2)}
          </div>
          {/* 原价仅在计抛时显示 */}
          {showVolumetricLabel && (
            <div className="text-[10px] text-muted-foreground line-through">
              实重价: ¥ {((billing?.actualWeight || 0) * channel.varFeePerGram + channel.fixFee).toFixed(2)}
            </div>
          )}
        </div>
      </div>

      {/* 3. 特货属性横条 - 醒目对比 */}
      <div className="mb-1.5 grid grid-cols-2 gap-1">
        <div className={`flex items-center justify-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold ${
          limits.allowBattery 
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
            : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          <Battery className="h-3 w-3" />
          {limits.allowBattery ? '可带电' : '禁带电'}
        </div>
        <div className={`flex items-center justify-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold ${
          limits.allowLiquid 
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
            : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          <Droplets className="h-3 w-3" />
          {limits.allowLiquid ? '可带液' : '禁带液'}
        </div>
      </div>

      {/* 4. 限制矩阵 */}
      <div className="grid grid-cols-2 gap-1 rounded border border-border bg-secondary p-1.5">
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Scale className="h-3 w-3 opacity-70" /> <b className="text-foreground">{limits.minWt}-{fDim(limits.maxWt)}g</b>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Ruler className="h-3 w-3 opacity-70" /> <b className="text-foreground">边{fDim(limits.maxSide)}cm</b>
        </div>
        <div className="text-[11px] text-muted-foreground">
          <span className="opacity-70">三边和:</span> <b className="text-foreground">{fDim(limits.maxSum)}cm</b>
        </div>
        <div className="text-[11px] text-muted-foreground">
          <span className="opacity-70">货值:</span>{" "}
          <b className="text-foreground">
            {minValueLabel}-{maxValueLabel}
          </b>
        </div>
      </div>

      {/* 5. 计费详情 (默认折叠) - 计费重醒目 - 带动画 */}
      <details className="group mt-2">
        <summary className="text-[10px] cursor-pointer hover:text-[#6366F1] list-none flex items-center gap-1 select-none font-medium">
          <span className="transition-transform duration-200 group-open:rotate-180">▼</span> 
          <span>查看计费详情 </span>
          <span className={`font-bold ${billing?.isVolumetric ? "text-[#EF4444]" : "text-foreground"}`}>
            (计费重: {freightData.billingWeight}g)
          </span>
        </summary>
        <div className="mt-2 text-[11px] bg-amber-50/50 p-3 rounded border-2 border-amber-200 space-y-2">
          {/* 实重 */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">实重:</span>
            <span className="font-medium">{billing?.actualWeight?.toFixed(0) || 0}g</span>
          </div>
          {/* 抛重 - 触发时醒目 */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">抛重:</span>
            <span className={`font-bold ${billing?.isVolumetric ? "text-[#F59E0B] bg-amber-100 px-1.5 rounded" : ""}`}>
              {billing?.volumetricWeight?.toFixed(0) || 0}g
              {billing?.isVolumetric && " ⚠️"}
            </span>
          </div>
          {/* 计费重 - 最醒目 */}
          <div className="flex justify-between font-bold pt-2 border-t-2 border-amber-300">
            <span>计费重:</span>
            <span className={`text-lg ${billing?.isVolumetric ? "text-[#EF4444] bg-red-100 px-2 rounded" : "text-[#6366F1] bg-indigo-100 px-2 rounded"}`}>
              {billing?.billingWeight?.toFixed(0) || 0}g
            </span>
          </div>
          {/* 计算公式 - 等宽字体 */}
          <div className="pt-2 border-t border-amber-200 text-[10px] font-mono bg-white/50 p-1.5 rounded">
            {freightData.formula}
          </div>
          
          {/* 计算轨迹 (Debug - dev only) */}
          {process.env.NODE_ENV === 'development' && (
          <CalculationTrace 
            channel={{
              name: channel.name,
              minWeight: channel.minWeight,
              maxWeight: channel.maxWeight,
              maxLength: channel.maxLength,
              maxSumDimension: channel.maxSumDimension,
              minValueRUB: channel.minValueRUB,
              maxValueRUB: channel.maxValueRUB,
              volumetricDivisor: channel.volumetricDivisor,
            }}
            input={{
              weight: input.weight,
              length: input.length,
              width: input.width,
              height: input.height,
              priceRUB: input.targetPriceRMB * input.exchangeRate,
            }}
            interceptionReasons={[]}
            isAvailable={true}
          />
          )}
        </div>
      </details>

      {/* 选中徽章 */}
      {isSelected && (
        <div className="absolute -top-2 -right-2 bg-[#6366F1] text-white text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm z-10">
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
          已选
        </div>
      )}
    </div>
  );
}
