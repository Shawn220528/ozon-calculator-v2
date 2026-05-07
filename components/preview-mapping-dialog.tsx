"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, CheckCircle2, Info, XCircle, Ruler, Sparkles, Upload, FileText } from "lucide-react";
import { ParsedData, FieldMapping, SizeConstraints, LOGISTICS_SCHEMA, getLogisticsFieldLabel, isInterceptorField, createLogisticsMappings } from "@/lib/smart-parser";

interface PreviewMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parsedData: ParsedData;
  dataType: "commission" | "shipping";
  onConfirm: (mappings: FieldMapping[]) => void;
  onCancel: () => void;
}

export function PreviewMappingDialog({
  open,
  onOpenChange,
  parsedData,
  dataType,
  onConfirm,
  onCancel,
}: PreviewMappingDialogProps) {
  const [mappings, setMappings] = useState<FieldMapping[]>(parsedData.mappings);
  
  // 初始化映射（如果尚未初始化）
  useEffect(() => {
    if (dataType === "shipping" && parsedData.headers.length > 0) {
      // 使用 LOGISTICS_SCHEMA 自动映射
      const autoMappings = createLogisticsMappings(parsedData.headers);
      setMappings(autoMappings);
    } else {
      setMappings(parsedData.mappings);
    }
  }, [parsedData.headers, dataType]);
  
  // 获取字段的中文标签
  const getFieldLabel = (systemField: string): string => {
    if (dataType === "shipping") {
      return getLogisticsFieldLabel(systemField);
    }
    // 佣金表标签
    const labels: Record<string, string> = {
      primaryCategory: "一级类目",
      secondaryCategory: "二级类目",
      tier1Rate: "阶梯1 (0-1500 RUB)",
      tier2Rate: "阶梯2 (1500-5000 RUB)",
      tier3Rate: "阶梯3 (5000+ RUB)",
    };
    return labels[systemField] || systemField;
  };
  
  // 判断字段是否为拦截字段
  const getIsInterceptor = (systemField: string): boolean => {
    if (dataType === "shipping") {
      return isInterceptorField(systemField);
    }
    return false;
  };
  
  // 获取字段级别
  const getFieldTier = (systemField: string): "required" | "interceptor" | "optional" => {
    const schemaField = LOGISTICS_SCHEMA.find(f => f.key === systemField);
    if (schemaField?.required) return "required";
    if (schemaField?.interceptor) return "interceptor";
    return "optional";
  };
  
  // 获取字段状态
  const getFieldStatus = (mapping: FieldMapping): "success" | "warning" | "error" | "ignored" => {
    const tier = getFieldTier(mapping.systemField);
    
    // 核心字段必须映射
    if (tier === "required") {
      if (mapping.columnIndex === -1) return "error";
      if (mapping.confidence >= 0.9) return "success";
      if (mapping.confidence >= 0.7) return "warning";
      return "error";
    }
    
    // 拦截字段和可选字段
    if (mapping.columnIndex === -1) return "ignored";
    if (mapping.confidence >= 0.9) return "success";
    if (mapping.confidence >= 0.7) return "warning";
    return "error";
  };
  
  // 更新单个映射
  const updateMapping = (systemField: string, columnIndex: number) => {
    setMappings(prev => prev.map(m => 
      m.systemField === systemField 
        ? { 
            ...m, 
            columnIndex, 
            csvColumn: parsedData.headers[columnIndex] || null,
            manual: true,
            confidence: 1.0,
          }
        : m
    ));
  };
  
  // 更新拦截开关
  const updateInterceptionEnabled = (systemField: string, enabled: boolean) => {
    setMappings(prev => prev.map(m => 
      m.systemField === systemField 
        ? { ...m, interceptionEnabled: enabled }
        : m
    ));
  };
  
  // 渲染字段状态图标
  const renderStatusIcon = (status: "success" | "warning" | "error" | "ignored") => {
    switch (status) {
      case "success":
        return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
      case "warning":
        return <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />;
      case "error":
        return <XCircle className="h-3.5 w-3.5 text-red-600" />;
      case "ignored":
        return <Info className="h-3.5 w-3.5 text-gray-400" />;
    }
  };
  
  // 预览数据行（只显示前5行）
  const previewRows = parsedData.rows.slice(0, 5);
  
  // 计算识别率
  const recognizedCount = mappings.filter(m => m.confidence >= 0.7 && m.columnIndex !== -1).length;
  const mappedCount = mappings.filter(m => m.columnIndex !== -1).length;
  const totalCount = mappings.length;
  const recognitionRate = Math.round((recognizedCount / totalCount) * 100);
  
  // 计算已启用拦截的字段数
  const interceptorEnabledCount = mappings.filter(m => m.interceptionEnabled === true).length;
  
  // 🔹 检查是否可以确认（只检查核心字段）
  const requiredFields = dataType === "shipping"
    ? LOGISTICS_SCHEMA.filter(f => f.required).map(f => f.key)
    : ["primaryCategory", "secondaryCategory", "tier1Rate", "tier2Rate", "tier3Rate"];
  const missingRequired = requiredFields.filter(field => {
    const mapping = mappings.find(m => m.systemField === field);
    return !mapping || mapping.columnIndex === -1;
  });
  
  const canConfirm = missingRequired.length === 0 && parsedData.errors.length === 0;
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] overflow-y-auto overflow-x-hidden !p-3 gap-2 flex flex-col">
        <DialogHeader className="pb-0">
          <DialogTitle className="flex items-center gap-1.5 text-sm">
            {dataType === "commission" ? "📊 佣金表智能导入向导" : "🚚 物流表智能导入向导"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            智能嗅探 CSV 表头，自动匹配系统字段。拦截字段可开关是否参与筛选。
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-1 max-w-full">
          {/* 步骤提示 */}
          <div className="flex items-center gap-1.5 text-xs flex-wrap">
            <div className="flex items-center gap-1 px-1.5 py-0.5 bg-indigo-50 rounded-full border border-indigo-200 whitespace-nowrap">
              <FileText className="h-3 w-3 text-[#6366F1]" />
              <span className="text-[#6366F1] font-medium">步骤1: 解析</span>
            </div>
            <span className="text-muted-foreground">→</span>
            <div className="flex items-center gap-1 px-1.5 py-0.5 bg-purple-50 rounded-full border border-purple-200 whitespace-nowrap">
              <Sparkles className="h-3 w-3 text-purple-600" />
              <span className="text-purple-700 font-medium">步骤2: 映射</span>
            </div>
          </div>
          
          {/* 解析状态 */}
          <div className={`p-1.5 rounded-lg border ${
            recognitionRate >= 90 ? "bg-green-50 border-green-200" :
            recognitionRate >= 70 ? "bg-amber-50 border-amber-200" :
            "bg-red-50 border-red-200"
          }`}>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span className="font-semibold text-xs whitespace-nowrap">
                识别 {recognizedCount}/{totalCount} ({recognitionRate}%)
              </span>
              {dataType === "shipping" && (
                <span className="text-xs text-purple-600 font-medium whitespace-nowrap">
                  ✓ 拦截 {interceptorEnabledCount} 个
                </span>
              )}
            </div>
            
            {/* 错误提示 */}
            {parsedData.errors.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {parsedData.errors.map((error, i) => (
                  <div key={i} className="flex items-start gap-1 text-xs text-red-700">
                    <XCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {/* 🔹 三列动态映射面板 */}
          <div className="border border-slate-200 rounded-lg overflow-hidden text-xs">
            <div className="grid grid-cols-12 bg-slate-100 border-b border-slate-300 font-semibold text-slate-700">
              <div className="col-span-4 p-1.5">系统字段</div>
              <div className="col-span-7 p-1.5">CSV 表头匹配</div>
              <div className="col-span-1 p-1.5 text-center">拦截</div>
            </div>
            
            {mappings.map((mapping) => {
              const status = getFieldStatus(mapping);
              const tier = getFieldTier(mapping.systemField);
              const isInterceptor = getIsInterceptor(mapping.systemField);
              
              return (
                <div 
                  key={mapping.systemField} 
                  className={`grid grid-cols-12 border-b border-slate-200 hover:bg-slate-50 transition-colors ${
                    status === "error" ? "bg-red-50" : ""
                  }`}
                >
                  {/* 列1: 系统字段名 */}
                  <div className="col-span-4 p-1.5 flex items-center gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-medium text-slate-800 truncate">{getFieldLabel(mapping.systemField)}</span>
                      {tier === "required" && (
                        <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-red-100 text-red-700 font-bold">必填</span>
                      )}
                      {tier === "interceptor" && (
                        <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 font-medium">拦截</span>
                      )}
                      {tier === "optional" && (
                        <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">可选</span>
                      )}
                    </div>
                  </div>
                  
                  {/* 列2: CSV 表头匹配下拉框 */}
                  <div className="col-span-7 p-1.5 flex items-center gap-1.5">
                    <div className="flex-1 min-w-0">
                      <Select
                        value={mapping.columnIndex.toString()}
                        onValueChange={(value) => updateMapping(mapping.systemField, parseInt(value))}
                      >
                        <SelectTrigger className={`w-full h-7 text-xs ${
                          status === "error" ? "border-red-300 bg-red-50" : 
                          status === "success" ? "border-green-300 bg-green-50" : ""
                        }`}>
                          <SelectValue placeholder="请选择列" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="-1">
                            {tier === "required" ? "⚠️ 必须选择" : "不映射（跳过）"}
                          </SelectItem>
                          {parsedData.headers.map((header, index) => (
                            <SelectItem key={index} value={index.toString()}>
                              {header || `列 ${index + 1}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      {renderStatusIcon(status)}
                    </div>
                  </div>
                  
                  {/* 列3: 启用拦截 Toggle */}
                  <div className="col-span-1 p-1.5 flex items-center justify-center">
                    {isInterceptor ? (
                      <div className="flex items-center gap-1">
                        <Switch
                          checked={mapping.interceptionEnabled === true}
                          onCheckedChange={(checked) => updateInterceptionEnabled(mapping.systemField, checked)}
                          className="data-[state=checked]:bg-purple-600 scale-75"
                        />
                        <span className={`text-[10px] font-medium ${
                          mapping.interceptionEnabled === true ? "text-purple-700" : "text-gray-400"
                        }`}>
                          {mapping.interceptionEnabled === true ? "开" : "关"}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-gray-400 italic">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          
          {/* 数据预览 */}
          <div className="w-full min-w-0 overflow-hidden">
            <h3 className="font-semibold mb-1 flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              数据预览（前 5 行）
            </h3>
            <div className="border rounded-lg overflow-x-auto max-h-48 w-full">
              <table style={{ minWidth: 'max-content', width: '100%' }} className="text-xs">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="p-1.5 text-left border-r whitespace-nowrap">#</th>
                    {parsedData.headers.map((header, i) => (
                      <th key={i} className="p-1.5 text-left border-r whitespace-nowrap min-w-[110px]">
                        {header || `列 ${i + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} className="border-t hover:bg-muted/50">
                      <td className="p-1.5 border-r font-medium whitespace-nowrap">{i + 1}</td>
                      {row.map((cell, j) => {
                        const isMapped = mappings.some(m => m.columnIndex === j);
                        const hasError = !cell || cell.trim() === "" || cell === "-";
                        return (
                          <td 
                            key={j} 
                            className={`p-1.5 border-r truncate min-w-[110px] ${
                              hasError && isMapped ? "bg-red-50 text-red-700" : ""
                            }`}
                          >
                            {cell || <span className="text-muted-foreground">-</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          
          {/* 🔹 尺寸约束解析结果 */}
          {dataType === "shipping" && parsedData.parsedConstraints && parsedData.parsedConstraints.size > 0 && (
            <div className="border rounded-lg p-1.5 bg-indigo-50/50 border-indigo-200">
              <h3 className="font-semibold mb-1 flex items-center gap-1 text-[#6366F1] text-xs">
                <Ruler className="h-3 w-3" />
                尺寸约束解析
              </h3>
              <div className="space-y-1 text-xs">
                {Array.from(parsedData.parsedConstraints.entries()).slice(0, 3).map(([rowKey, constraints]) => {
                  const rowIndex = parseInt(rowKey.replace("row_", ""));
                  const row = parsedData.rows[rowIndex];
                  const channelName = row ? row[0] : `渠道 ${rowIndex + 1}`;
                  
                  return (
                    <div key={rowKey} className="p-1.5 bg-card rounded border border-border">
                      <div className="font-medium mb-0.5 truncate">{channelName}</div>
                      <div className="flex gap-3 text-foreground">
                        {constraints.maxSum !== null && (
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" />
                            总和≤{constraints.maxSum}cm
                          </span>
                        )}
                        {constraints.maxLongEdge !== null && (
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" />
                            长边≤{constraints.maxLongEdge}cm
                          </span>
                        )}
                        {constraints.maxSum === null && constraints.maxLongEdge === null && (
                          <span className="flex items-center gap-1 text-amber-600">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            未识别，需手动
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {parsedData.parsedConstraints.size > 3 && (
                  <div className="text-xs text-muted-foreground italic">
                    ... 还有 {parsedData.parsedConstraints.size - 3} 个
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        
        <DialogFooter className="flex-col items-stretch gap-1">
          {/* 🔹 状态摘要 */}
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pb-0.5 border-b">
            <span>已映射 {mappedCount}/{totalCount}</span>
            {dataType === "shipping" && interceptorEnabledCount > 0 && (
              <span className="text-purple-600 font-medium">拦截 {interceptorEnabledCount} 个</span>
            )}
          </div>
          
          {/* 🔹 缺失必填字段提示 */}
          {missingRequired.length > 0 && (
            <div className="p-1.5 rounded-lg bg-red-50 border border-red-200 text-xs">
              <div className="flex items-start gap-1">
                <XCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />
                <div>
                  <span className="font-bold text-red-700">缺少：</span>
                  <span className="text-red-700">
                    {missingRequired.map(f => getFieldLabel(f)).join("、")}
                  </span>
                </div>
              </div>
            </div>
          )}
          
          {/* 🔹 按钮区域 */}
          <div className="flex gap-2 pt-0.5">
            <Button variant="outline" onClick={onCancel} className="flex-1 h-8 text-xs">取消</Button>
            <Button onClick={() => onConfirm(mappings)} disabled={!canConfirm} className="flex-1 h-8 text-xs">
              {canConfirm ? "确认导入" : "请映射必填字段"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}