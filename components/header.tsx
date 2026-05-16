"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Calculator, DollarSign, Settings, Database, Download, Upload, Check, Trash2, AlertTriangle, FileSpreadsheet, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDataHub } from "@/lib/data-hub-context";
import { CalculationInput } from "@/lib/types";
import { downloadCommissionTemplate, downloadShippingTemplate } from "@/lib/template-export";
import { PreviewMappingDialog } from "@/components/preview-mapping-dialog";
import { smartParseCSV, validateData, ParsedData, FieldMapping, saveMappingToHistory, loadMappingFromHistory } from "@/lib/smart-parser";
import Papa from "papaparse";

interface HeaderProps {
  exchangeRate: number;
  onExchangeRateChange: (rate: number) => void;
  withdrawalFee: number;
  onWithdrawalFeeChange: (fee: number) => void;
  exchangeRateBuffer?: number;
  onExchangeRateBufferChange?: (buffer: number) => void;
  // 配置导入所需
  input?: CalculationInput;
  onInputChange?: (input: CalculationInput) => void;
}

export function Header({
  exchangeRate,
  onExchangeRateChange,
  withdrawalFee,
  onWithdrawalFeeChange,
  exchangeRateBuffer = 0,
  onExchangeRateBufferChange,
  input,
  onInputChange,
}: HeaderProps) {
  const { 
    loadCommissionData, 
    loadShippingData, 
    clearCommissionData, 
    clearShippingData,
    commissionLoaded, 
    shippingLoaded, 
    commissionData, 
    shippingData 
  } = useDataHub();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingShippingFile, setPendingShippingFile] = useState<File | null>(null);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showClearCommissionDialog, setShowClearCommissionDialog] = useState(false);
  const [showClearShippingDialog, setShowClearShippingDialog] = useState(false);
  
  // 🔹 智能预览状态
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [previewDataType, setPreviewDataType] = useState<"commission" | "shipping">("commission");
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // 自动获取汇率
  const [isFetchingRate, setIsFetchingRate] = useState(false);
  const [rateFetchError, setRateFetchError] = useState<string | null>(null);
  const [lastFetchTime, setLastFetchTime] = useState<Date | null>(null);

  // 自动获取汇率函数
  const fetchExchangeRate = useCallback(async () => {
    setIsFetchingRate(true);
    setRateFetchError(null);
    
    try {
      // 使用免费汇率 API: 返回 1 RUB = X CNY，需要转为 1 CNY = X RUB
      const response = await fetch('https://open.er-api.com/v6/latest/RUB');
      
      if (!response.ok) {
        throw new Error('汇率API请求失败');
      }
      
      const data = await response.json();
      
      if (data.rates && data.rates.CNY) {
        const rate = 1 / parseFloat(data.rates.CNY.toFixed(6));
        onExchangeRateChange(parseFloat(rate.toFixed(4)));
        setLastFetchTime(new Date());
      } else {
        throw new Error('汇率数据格式错误');
      }
    } catch (error) {
      console.error('获取汇率失败:', error);
      setRateFetchError('获取失败，请手动输入');
    } finally {
      setIsFetchingRate(false);
    }
  }, [onExchangeRateChange]);

  // 组件加载时自动获取汇率
  useEffect(() => {
    fetchExchangeRate();
  }, []); // 只在组件挂载时执行一次

  // 🔹 智能解析文件
  const parseFile = async (file: File, type: "commission" | "shipping"): Promise<ParsedData> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (e) => {
        try {
          const content = e.target?.result as string;
          const parsed = smartParseCSV(content, type);
          
          // 尝试加载历史映射
          if (parsed.headers.length > 0) {
            const historicalMapping = loadMappingFromHistory(parsed.headers, type);
            if (historicalMapping) {
              parsed.mappings = historicalMapping;
              parsed.recognizedCount = historicalMapping.filter(m => m.confidence >= 0.7).length;
              parsed.warnings.push("已加载上次成功的字段映射");
            }
          }
          
          // 🔹 打印解析成功的字段映射结果
          console.log(`✅ 解析成功 - ${type === "commission" ? "佣金表" : "物流表"}`);
          console.log("📋 识别的表头:", parsed.headers);
          console.log("🗺️ 字段映射:", parsed.mappings.map(m => 
            `${m.systemField} → ${m.csvColumn} (置信度: ${(m.confidence * 100).toFixed(1)}%)`
          ));
          console.log(`📊 识别进度: ${parsed.recognizedCount}/${parsed.totalCount}`);
          if (parsed.warnings.length > 0) {
            console.log("⚠️ 警告:", parsed.warnings);
          }
          if (parsed.errors.length > 0) {
            console.log("❌ 错误:", parsed.errors);
          }
          
          resolve(parsed);
        } catch (error) {
          console.error("❌ 解析失败:", error);
          reject(error);
        }
      };
      
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsText(file);
    });
  };

  // 🔹 佣金表上传处理（集成预览）
  const handleCommissionUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    setIsUploading(true);
    setUploadMessage(null);
    
    try {
      // 智能解析文件
      const parsed = await parseFile(file, "commission");
      
      // 检查解析结果
      if (parsed.errors.length > 0) {
        setUploadMessage(`解析失败: ${parsed.errors.join("; ")}`);
        setIsUploading(false);
        return;
      }
      
      // 如果识别率 >= 90%，直接导入
      const recognitionRate = (parsed.recognizedCount / parsed.totalCount) * 100;
      if (recognitionRate >= 90 && parsed.warnings.length === 0) {
        await confirmImport(file, parsed.mappings, "commission");
      } else {
        // 否则显示预览对话框
        setParsedData(parsed);
        setPreviewDataType("commission");
        setPendingFile(file);
        setShowPreviewDialog(true);
      }
    } catch (e) {
      setUploadMessage(`上传失败: ${(e as Error).message}`);
    } finally {
      setIsUploading(false);
    }
  };

  // 🔹 物流表上传处理（集成预览）
  const handleShippingUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadMessage(null);
    
    try {
      // 智能解析文件
      const parsed = await parseFile(file, "shipping");
      
      // 检查解析结果
      if (parsed.errors.length > 0) {
        setUploadMessage(`解析失败: ${parsed.errors.join("; ")}`);
        setIsUploading(false);
        return;
      }
      
      // 如果识别率 >= 90%，检查冲突后导入
      const recognitionRate = (parsed.recognizedCount / parsed.totalCount) * 100;
      if (recognitionRate >= 90 && parsed.warnings.length === 0) {
        // 检测是否已存在物流数据
        if (shippingLoaded && shippingData.length > 0) {
          setPendingShippingFile(file);
          setShowConflictDialog(true);
        } else {
          await confirmImport(file, parsed.mappings, "shipping");
        }
      } else {
        // 否则显示预览对话框
        setParsedData(parsed);
        setPreviewDataType("shipping");
        setPendingFile(file);
        setShowPreviewDialog(true);
      }
    } catch (e) {
      setUploadMessage(`上传失败: ${(e as Error).message}`);
    } finally {
      setIsUploading(false);
    }
  };

  // 🔹 确认导入（应用映射关系）
  const confirmImport = async (file: File, mappings: FieldMapping[], type: "commission" | "shipping") => {
    setIsUploading(true);
    setShowPreviewDialog(false);
    
    try {
      // 保存映射关系到历史
      saveMappingToHistory(file.name, mappings, type);
      
      // 调用原有的加载函数
      if (type === "commission") {
        await loadCommissionData(file);
        setUploadMessage("佣金表上传成功！");
      } else {
        await loadShippingData(file, "overwrite");
        setUploadMessage("物流表上传成功！");
      }
    } catch (e) {
      setUploadMessage(`导入失败: ${(e as Error).message}`);
    } finally {
      setIsUploading(false);
      setParsedData(null);
      setPendingFile(null);
    }
  };

  // 处理覆盖选择
  const handleOverwrite = async () => {
    if (!pendingShippingFile) return;
    setShowConflictDialog(false);
    setIsUploading(true);
    setUploadMessage(null);
    try {
      // 🔹 智能解析文件
      const parsed = await parseFile(pendingShippingFile, "shipping");
      
      // 检查解析结果
      if (parsed.errors.length > 0) {
        setUploadMessage(`解析失败: ${parsed.errors.join("; ")}`);
        setIsUploading(false);
        return;
      }
      
      // 如果识别率 >= 90%，直接导入
      const recognitionRate = (parsed.recognizedCount / parsed.totalCount) * 100;
      if (recognitionRate >= 90 && parsed.warnings.length === 0) {
        await confirmImport(pendingShippingFile, parsed.mappings, "shipping");
        setUploadMessage("物流表已覆盖上传成功！");
      } else {
        // 否则显示预览对话框
        setParsedData(parsed);
        setPreviewDataType("shipping");
        setPendingFile(pendingShippingFile);
        setShowPreviewDialog(true);
      }
    } catch (e) {
      setUploadMessage(`上传失败: ${(e as Error).message}`);
    } finally {
      setIsUploading(false);
      setPendingShippingFile(null);
    }
  };

  // 处理并存选择
  const handleMerge = async () => {
    if (!pendingShippingFile) return;
    setShowConflictDialog(false);
    setIsUploading(true);
    setUploadMessage(null);
    try {
      // 🔹 智能解析文件
      const parsed = await parseFile(pendingShippingFile, "shipping");
      
      // 检查解析结果
      if (parsed.errors.length > 0) {
        setUploadMessage(`解析失败: ${parsed.errors.join("; ")}`);
        setIsUploading(false);
        return;
      }
      
      // 直接加载（并存模式）
      await loadShippingData(pendingShippingFile, "merge");
      setUploadMessage("物流表已并存更新成功！");
    } catch (e) {
      setUploadMessage(`上传失败: ${(e as Error).message}`);
    } finally {
      setIsUploading(false);
      setPendingShippingFile(null);
    }
  };

  // 配置导出
  const handleExportConfig = () => {
    const config = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      input: input || null,
      commissionData,
      shippingData,
      globalSettings: {
        exchangeRate,
        withdrawalFee,
      },
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ozon-calculator-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setBackupMessage("配置已导出！");
    setTimeout(() => setBackupMessage(null), 2000);
  };

  // 配置导入
  const handleImportConfig = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const config = JSON.parse(e.target?.result as string);
        
        // 恢复全局设置
        if (config.globalSettings) {
          onExchangeRateChange(config.globalSettings.exchangeRate);
          onWithdrawalFeeChange(config.globalSettings.withdrawalFee);
        }

        // 恢复输入参数
        if (config.input && onInputChange) {
          onInputChange(config.input);
        }

        // 恢复佣金数据
        if (config.commissionData && Array.isArray(config.commissionData)) {
          localStorage.setItem("ozon_commission_data", JSON.stringify(config.commissionData));
          window.location.reload(); // 刷新页面以加载新数据
        }

        // 恢复物流数据
        if (config.shippingData && Array.isArray(config.shippingData)) {
          localStorage.setItem("ozon_shipping_data", JSON.stringify(config.shippingData));
        }

        setBackupMessage("配置已导入！页面将刷新...");
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } catch (err) {
        setBackupMessage(`导入失败: ${(err as Error).message}`);
        setTimeout(() => setBackupMessage(null), 3000);
      }
    };
    reader.readAsText(file);
    // 重置 file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // 清除佣金数据
  const handleClearCommission = () => {
    clearCommissionData();
    setShowClearCommissionDialog(false);
    setUploadMessage("佣金数据已清除！");
    setTimeout(() => setUploadMessage(null), 2000);
  };

  // 清除物流数据
  const handleClearShipping = () => {
    clearShippingData();
    setShowClearShippingDialog(false);
    setUploadMessage("物流数据已清除！");
    setTimeout(() => setUploadMessage(null), 2000);
  };

  // 🔹 处理预览对话框取消
  const handlePreviewCancel = () => {
    setShowPreviewDialog(false);
    setParsedData(null);
    setPendingFile(null);
  };

  return (
    <>
      {/* 🔹 智能预览映射对话框 */}
      {parsedData && (
        <PreviewMappingDialog
          open={showPreviewDialog}
          onOpenChange={setShowPreviewDialog}
          parsedData={parsedData}
          dataType={previewDataType}
          onConfirm={(mappings) => {
            if (pendingFile) {
              confirmImport(pendingFile, mappings, previewDataType);
            }
          }}
          onCancel={handlePreviewCancel}
        />
      )}
    
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-3">
          {/* Logo图标区域 */}
          <div className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 shadow-md">
            <svg 
              viewBox="0 0 24 24" 
              className="w-5 h-5 text-white"
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            >
              <path d="M12 2v20M2 12h20" strokeOpacity="0.3" />
              <path d="M7 7h.01M7 12h.01M7 17h.01M12 7h.01M12 12h.01M12 17h.01M17 7h.01M17 12h.01M17 17h.01" />
            </svg>
            {/* 装饰角标 */}
            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-white/30 rounded-full" />
          </div>
          
          {/* 系统名称区域 */}
          <div className="flex flex-col">
            <h1 className="text-lg font-bold leading-tight tracking-tight">
              <span className="text-orange-600">Ozon</span>
              <span className="text-slate-800"> rFBS</span>
            </h1>
            <span className="text-[10px] text-muted-foreground/70 tracking-wide">跨境精算系统</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <Label className="text-xs whitespace-nowrap">汇率:</Label>
            <Input
              type="number"
              step="0.001"
              min="0.001"
              value={exchangeRate}
              onChange={(e) => onExchangeRateChange(parseFloat(e.target.value) || 12)}
              className="w-20 h-7 text-xs"
            />
            <span className="text-xs text-muted-foreground">
              1¥={exchangeRate.toFixed(3)}₽
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={fetchExchangeRate}
              disabled={isFetchingRate}
              title={lastFetchTime ? `上次更新: ${lastFetchTime.toLocaleTimeString()}` : "自动获取汇率"}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetchingRate ? "animate-spin" : ""}`} />
            </Button>
            {rateFetchError && (
              <span className="text-xs text-orange-600">
                {rateFetchError}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Label className="text-xs whitespace-nowrap">提现汇损:</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              value={withdrawalFee}
              onChange={(e) => onWithdrawalFeeChange(parseFloat(e.target.value) || 1.5)}
              className="w-16 h-7 text-xs"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Label className="text-xs whitespace-nowrap">汇率安全垫:</Label>
            <Input
              type="number"
              step="1"
              min="0"
              max="50"
              value={exchangeRateBuffer}
              onChange={(e) => onExchangeRateBufferChange?.(parseFloat(e.target.value) || 0)}
              className="w-16 h-7 text-xs"
              title="实际计算汇率 = 实时汇率 × (1 - 安全垫%)"
            />
            <span className="text-xs text-muted-foreground">%</span>
            {exchangeRateBuffer > 0 && (
              <span className="text-xs text-orange-600">
                实际={(exchangeRate * (1 - exchangeRateBuffer / 100)).toFixed(4)}
              </span>
            )}
          </div>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs">
                <Database className="h-3.5 w-3.5" />
                数据中心
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>数据源管理</DialogTitle>
                <DialogDescription>
                  上传最新的费率表以更新系统计算数据
                </DialogDescription>
              </DialogHeader>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm">Ozon 佣金表 (.csv / .xlsx)</Label>
                  <Input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    onChange={handleCommissionUpload}
                    disabled={isUploading}
                    className="text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    包含一级类目、二级类目和阶梯佣金率。支持 .csv 和 .xlsx 格式
                  </p>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium">物流费率表 (.xlsx / .csv)</Label>
                  <Input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    onChange={handleShippingUpload}
                    disabled={isUploading}
                    className="text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    包含物流渠道、价格、时效和限制条件。支持 .xlsx 和 .csv 格式
                  </p>
                </div>

                {uploadMessage && (
                  <div className={`text-sm p-2 rounded ${
                    uploadMessage.includes("成功") ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                  }`}>
                    {uploadMessage}
                  </div>
                )}

                <div className="pt-4 border-t">
                  <h4 className="font-medium text-sm mb-3">下载标准模板</h4>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 gap-1.5 h-8 text-xs"
                      onClick={downloadCommissionTemplate}
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      佣金表模板
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 gap-1.5 h-8 text-xs"
                      onClick={downloadShippingTemplate}
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      物流表模板
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    无法识别复杂表格？下载标准模板填写后上传
                  </p>
                </div>

                {/* 使用说明 */}
                <div className="pt-4 border-t">
                  <h4 className="font-medium text-sm mb-2 flex items-center gap-1.5">
                    <span>📖</span> 使用说明
                  </h4>
                  <div className="text-xs text-muted-foreground space-y-2 bg-slate-50 p-3 rounded-lg">
                    <div className="font-medium text-slate-700">物流表字段要求：</div>
                    <div className="pl-2 space-y-1">
                      <div>• <span className="font-mono text-blue-600">配送方式</span> - 物流渠道名称（必填）</div>
                      <div>• <span className="font-mono text-blue-600">服务等级</span> - Express/Standard/Economy</div>
                      <div>• <span className="font-mono text-blue-600">评分组</span> - Extra Small/Small/Big</div>
                      <div>• <span className="font-mono text-blue-600">费率</span> - 格式: ¥3.12 + ¥0.0468/1g</div>
                      <div>• <span className="font-mono text-blue-600">尺寸限制</span> - 格式: 边长总和≤90cm,长边≤60cm</div>
                      <div>• <span className="font-mono text-blue-600">货值限制-卢布</span> - 格式: 1501-7000</div>
                    </div>
                    <div className="font-medium text-slate-700 mt-2">诊断功能：</div>
                    <div className="pl-2 space-y-1">
                      <div>• 上传后打开 <span className="font-mono">F12</span> 查看 Console 日志</div>
                      <div>• <span className="text-green-600">✅</span> = 字段匹配成功</div>
                      <div>• <span className="text-yellow-600">⚠️</span> = 未匹配（检查表头拼写）</div>
                    </div>
                    <div className="font-medium text-slate-700 mt-2">常见问题：</div>
                    <div className="pl-2 space-y-1">
                      <div>• Excel 打开乱码 → 已自动添加 UTF-8 BOM</div>
                      <div>• 字段未识别 → 表头需包含中文或英文别名</div>
                      <div>• 计费错误 → 展开卡片详情查看计算轨迹</div>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t">
                  <h4 className="font-medium text-sm mb-2">当前数据状态</h4>
                  <div className="text-sm space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">佣金表:</span>
                      <div className="flex items-center gap-2">
                        <span className={commissionLoaded ? "text-green-600 font-medium" : "text-red-600"}>
                          {commissionLoaded ? `已加载 (${commissionData.length} 条)` : "未加载"}
                        </span>
                        {commissionLoaded && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs border-red-300 text-red-600 hover:bg-red-50"
                            onClick={() => setShowClearCommissionDialog(true)}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            清除
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">物流表:</span>
                      <div className="flex items-center gap-2">
                        <span className={shippingLoaded ? "text-green-600 font-medium" : "text-red-600"}>
                          {shippingLoaded ? `已加载 (${shippingData.length} 条)` : "未加载"}
                        </span>
                        {shippingLoaded && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs border-red-300 text-red-600 hover:bg-red-50"
                            onClick={() => setShowClearShippingDialog(true)}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            清除
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* 配置备份按钮 */}
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs">
                <Settings className="h-3.5 w-3.5" />
                配置备份
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>配置备份与恢复</DialogTitle>
                <DialogDescription>
                  导出/导入完整的配置，实现跨电脑迁移
                </DialogDescription>
              </DialogHeader>
              
              <div className="space-y-4">
                {/* 导出配置 */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">导出配置</Label>
                  <p className="text-xs text-muted-foreground">
                    一键下载包含所有设置、费率数据的 .json 文件
                  </p>
                  <Button
                    onClick={handleExportConfig}
                    className="w-full gap-2"
                    size="sm"
                  >
                    <Download className="h-4 w-4" />
                    导出配置文件
                  </Button>
                </div>

                {/* 导入配置 */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">导入配置</Label>
                  <p className="text-xs text-muted-foreground">
                    上传之前导出的 .json 文件，立即恢复所有数据
                  </p>
                  <Input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleImportConfig}
                    className="text-sm"
                  />
                </div>

                {backupMessage && (
                  <div className={`text-sm p-2 rounded flex items-center gap-2 ${
                    backupMessage.includes("成功") || backupMessage.includes("已导出") || backupMessage.includes("已导入")
                      ? "bg-green-50 text-green-700"
                      : "bg-red-50 text-red-700"
                  }`}>
                    <Check className="h-4 w-4" />
                    {backupMessage}
                  </div>
                )}

                <div className="pt-4 border-t">
                  <h4 className="font-medium text-sm mb-2">备份内容说明</h4>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <div>✓ 汇率、提现手续费等全局设置</div>
                    <div>✓ 商品参数、成本、广告设置</div>
                    <div>✓ 已解析的佣金费率表</div>
                    <div>✓ 已解析的物流渠道表</div>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 物流数据冲突选择弹窗 */}
      <AlertDialog open={showConflictDialog} onOpenChange={setShowConflictDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              检测到已存在物流数据
            </AlertDialogTitle>
            <AlertDialogDescription>
              当前已加载 {shippingData.length} 条物流渠道数据。请选择如何处理新上传的数据：
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel onClick={() => {
              setShowConflictDialog(false);
              setPendingShippingFile(null);
            }}>
              取消上传
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleMerge}
              className="bg-blue-600 hover:bg-blue-700"
            >
              并存更新（推荐）
            </AlertDialogAction>
            <AlertDialogAction
              onClick={handleOverwrite}
              className="bg-red-600 hover:bg-red-700"
            >
              覆盖旧数据
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 清除佣金数据确认弹窗 */}
      <AlertDialog open={showClearCommissionDialog} onOpenChange={setShowClearCommissionDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              确认清除佣金数据？
            </AlertDialogTitle>
            <AlertDialogDescription>
              此操作将删除当前已加载的 {commissionData.length} 条佣金数据，且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearCommission}
              className="bg-red-600 hover:bg-red-700"
            >
              确认清除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 清除物流数据确认弹窗 */}
      <AlertDialog open={showClearShippingDialog} onOpenChange={setShowClearShippingDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              确认清除物流数据？
            </AlertDialogTitle>
            <AlertDialogDescription>
              此操作将删除当前已加载的 {shippingData.length} 条物流渠道数据，且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearShipping}
              className="bg-red-600 hover:bg-red-700"
            >
              确认清除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
    </>
  );
}
