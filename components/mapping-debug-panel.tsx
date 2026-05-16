"use client";

import { useState } from "react";
import { LOGISTICS_FIELDS, matchHeaderToField } from "@/lib/constants";

interface MappingDiagnostic {
  header: string;
  matchedField: string | null;
  sampleValue: string;
  parsedValue: string;
  status: 'success' | 'warning' | 'error';
}

interface DebugPanelProps {
  headers: string[];
  sampleRows: string[][];
  visible: boolean;
  onClose: () => void;
}

/**
 * 映射诊断面板
 * 展示 CSV 列名 → 系统字段的映射关系和解析结果
 */
export function MappingDebugPanel({ headers, sampleRows, visible, onClose }: DebugPanelProps) {
  if (!visible) return null;

  // 生成诊断数据
  const diagnostics: MappingDiagnostic[] = headers.map((header, index) => {
    const matchedField = matchHeaderToField(header);
    const fieldSchema = LOGISTICS_FIELDS.find(f => f.key === matchedField);
    const sampleValue = sampleRows[0]?.[index] || '-';
    
    // 模拟解析结果
    let parsedValue = '-';
    let status: 'success' | 'warning' | 'error' = 'success';
    
    if (!matchedField) {
      status = 'warning';
      parsedValue = '(未匹配)';
    } else if (fieldSchema?.type === 'price-range' && sampleValue) {
      const cleanStr = sampleValue.replace(/\s/g, '');
      const match = cleanStr.match(/([\d.]+)[-–—]([\d.]+)/);
      if (match) {
        parsedValue = `{ min: ${match[1]}, max: ${match[2]} }`;
      } else {
        parsedValue = `{ max: ${cleanStr} }`;
      }
    } else if (fieldSchema?.type === 'dimension-nlp' && sampleValue) {
      const sumMatch = sampleValue.match(/(?:总和|sum|сумма)\s*[≤<]?\s*(\d+)/i);
      const lenMatch = sampleValue.match(/(?:长边|length|длин[аы]?)\s*[≤<]?\s*(\d+)/i);
      const parts = [];
      if (sumMatch) parts.push(`maxSum: ${sumMatch[1]}`);
      if (lenMatch) parts.push(`maxSide: ${lenMatch[1]}`);
      parsedValue = parts.length > 0 ? `{ ${parts.join(', ')} }` : sampleValue;
    } else if (fieldSchema?.type === 'number' && sampleValue) {
      const num = parseFloat(sampleValue.replace(/[^\d.]/g, ''));
      parsedValue = isNaN(num) ? sampleValue : num.toString();
    } else {
      parsedValue = sampleValue;
    }
    
    return { header, matchedField, sampleValue, parsedValue, status };
  });

  // 统计
  const matchedCount = diagnostics.filter(d => d.matchedField).length;
  const unmatchedCount = diagnostics.filter(d => !d.matchedField).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120]">
      <div className="bg-white rounded-xl shadow-2xl w-[90vw] max-w-4xl max-h-[80vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold text-slate-800">🔍 映射诊断模式</h2>
            <p className="text-xs text-slate-500 mt-1">
              已匹配 {matchedCount} 个字段，{unmatchedCount} 个未匹配
            </p>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-xl"
          >
            ✕
          </button>
        </div>

        {/* 诊断表格 */}
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                <th className="text-left p-2 font-medium text-slate-600">状态</th>
                <th className="text-left p-2 font-medium text-slate-600">系统字段</th>
                <th className="text-left p-2 font-medium text-slate-600">匹配到的 CSV 列名</th>
                <th className="text-left p-2 font-medium text-slate-600">原始样本值</th>
                <th className="text-left p-2 font-medium text-slate-600">解析后的数值</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.map((d, i) => (
                <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="p-2">
                    {d.status === 'success' && <span className="text-green-600">✅</span>}
                    {d.status === 'warning' && <span className="text-yellow-600">⚠️</span>}
                    {d.status === 'error' && <span className="text-red-600">❌</span>}
                  </td>
                  <td className="p-2">
                    {d.matchedField ? (
                      <span className="font-mono text-[#6366F1]">{d.matchedField}</span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="p-2 font-mono text-foreground">{d.header}</td>
                  <td className="p-2 text-muted-foreground max-w-[200px] truncate">{d.sampleValue}</td>
                  <td className="p-2 font-mono text-foreground">{d.parsedValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 底部提示 */}
        <div className="p-4 border-t bg-slate-50 text-xs text-slate-500">
          <p>💡 提示：如果映射不正确，请检查 CSV 表头是否包含字段别名（参见 Schema Registry）</p>
        </div>
      </div>
    </div>
  );
}

/**
 * 计算轨迹组件
 * 显示渠道筛选的详细判定过程
 */
interface CalculationTraceProps {
  channel: {
    name: string;
    minWeight: number;
    maxWeight: number;
    maxLength: number;
    maxSumDimension: number;
    minValueRUB?: number;
    maxValueRUB?: number;
    volumetricDivisor: number;
  };
  input: {
    weight: number;
    length: number;
    width: number;
    height: number;
    priceRUB: number;
  };
  interceptionReasons: string[];
  isAvailable: boolean;
}

export function CalculationTrace({ channel, input, interceptionReasons, isAvailable }: CalculationTraceProps) {
  const sumDim = input.length + input.width + input.height;
  const sides = [input.length, input.width, input.height].sort((a, b) => b - a);
  
  return (
    <div className="mt-3 p-3 bg-slate-50 rounded-lg border border-slate-200 text-[10px]">
      <div className="font-bold text-slate-700 mb-2">🔬 计算轨迹 (Debug Trace)</div>
      
      {/* 输入 */}
      <div className="mb-2">
        <div className="text-slate-500 font-medium">[输入]</div>
        <div className="pl-2 text-slate-600">
          商品尺寸：{input.length}×{input.width}×{input.height}cm, {input.weight}g, {input.priceRUB}₽
        </div>
      </div>
      
      {/* 映射 */}
      <div className="mb-2">
        <div className="text-slate-500 font-medium">[映射] 该渠道解析出的限制</div>
        <div className="pl-2 text-slate-600">
          最长边≤{channel.maxLength}cm, 总和≤{channel.maxSumDimension}cm, 
          重量{channel.minWeight}-{channel.maxWeight}g,
          货值[{channel.minValueRUB ?? 0}-{channel.maxValueRUB ?? "无上限"}]₽
        </div>
      </div>
      
      {/* 对比 */}
      <div className="mb-2">
        <div className="text-slate-500 font-medium">[对比] 逐项判定</div>
        <div className="pl-2 space-y-1">
          {/* 长边 */}
          <div className={sides[0] <= channel.maxLength ? "text-green-600" : "text-red-600"}>
            • 最长边 {sides[0]} ≤ {channel.maxLength} → {sides[0] <= channel.maxLength ? "Pass" : "Fail: 单边超限"}
          </div>
          
          {/* 三边和 */}
          <div className={sumDim <= channel.maxSumDimension ? "text-green-600" : "text-red-600"}>
            • 三边和 {sumDim} ≤ {channel.maxSumDimension} → {sumDim <= channel.maxSumDimension ? "Pass" : "Fail: 三边和超限"}
          </div>
          
          {/* 重量 */}
          <div className={input.weight <= channel.maxWeight ? "text-green-600" : "text-red-600"}>
            • 实重 {input.weight}g ≤ {channel.maxWeight}g → {input.weight <= channel.maxWeight ? "Pass" : "Fail: 超重"}
          </div>
          
          {/* 货值下限 */}
          {channel.minValueRUB && (
            <div className={input.priceRUB >= channel.minValueRUB ? "text-green-600" : "text-red-600"}>
              • 货值 {input.priceRUB}₽ ≥ {channel.minValueRUB}₽ → {input.priceRUB >= channel.minValueRUB ? "Pass" : "Fail: 货值低于评分组下限"}
            </div>
          )}
          
          {/* 货值上限 */}
          {channel.maxValueRUB !== undefined && (
            <div className={input.priceRUB <= channel.maxValueRUB ? "text-green-600" : "text-red-600"}>
              • 货值 {input.priceRUB}₽ ≤ {channel.maxValueRUB}₽ → {input.priceRUB <= channel.maxValueRUB ? "Pass" : "Fail: 货值超限"}
            </div>
          )}
        </div>
      </div>
      
      {/* 结论 */}
      <div className="mt-2 pt-2 border-t border-slate-200">
        {isAvailable ? (
          <div className="text-green-600 font-bold">✅ 渠道可用</div>
        ) : (
          <div className="text-red-600 font-bold">
            ❌ 渠道不可用：
            <ul className="pl-4 mt-1 font-normal">
              {interceptionReasons.map((reason, i) => (
                <li key={i}>• {reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
