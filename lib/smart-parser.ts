/**
 * 智能解析引擎
 * 实现模糊表头匹配、语义预判和数据校验
 */

// 🔴 生产环境静默日志
const isDev = process.env.NODE_ENV === 'development';
const devLog = isDev ? console.log : () => {};
const devWarn = isDev ? console.warn : () => {};

// ========================================================
// 类型定义
// ========================================================

export interface FieldMapping {
  systemField: string;      // 系统字段名
  csvColumn: string | null; // CSV 列名
  columnIndex: number;      // 列索引
  confidence: number;       // 匹配置信度 (0-1)
  manual?: boolean;         // 是否手动指定
  interceptionEnabled?: boolean; // 🔹 是否启用拦截筛选（仅拦截字段）
}

export interface ParsedData {
  headers: string[];
  rows: string[][];
  mappings: FieldMapping[];
  recognizedCount: number;
  totalCount: number;
  warnings: string[];
  errors: string[];
  // 🔹 新增：解析后的尺寸约束数据
  parsedConstraints?: Map<string, SizeConstraints>; // 行索引 -> 约束数据
}

export interface SynonymBank {
  [key: string]: string[]; // 字段名 -> 同义词列表
}

// ========================================================
// LOGISTICS_SCHEMA - 物流表系统字段库
// ========================================================

export interface LogisticsSchemaField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'any';
  required: boolean;
  interceptor?: boolean; // 是否参与拦截引擎
  aliases: string[];     // CSV 表头同义词
}

export const LOGISTICS_SCHEMA: LogisticsSchemaField[] = [
  // --- 基础必填项 (不可关闭筛选) ---
  { key: 'serviceTier', label: '评分组', type: 'string', required: true, aliases: ['评分组', 'Scoring', 'tier', 'Extra Small', 'Small', 'Big', 'Budget'] },
  { key: 'serviceLevel', label: '服务等级', type: 'string', required: true, aliases: ['服务等级', 'Service', 'level', '等级', 'Express', 'Standard', 'Economy'] },
  { key: 'thirdParty', label: '第三方物流', type: 'string', required: true, aliases: ['第三方物流', '3PL', 'carrier', '物流商', 'RETS', 'ZTO', 'ATC', 'GUOO'] },
  { key: 'name', label: '配送方式', type: 'string', required: true, aliases: ['配送方式', 'Method', 'channel', '方式', 'RETS Express', 'ZTO Standard'] },
  { key: 'rate', label: '费率', type: 'string', required: true, aliases: ['费率', 'rate', '费用', '运费', '费率（PUDO揽收点揽收'] },

  // --- 拦截限制项 (深度参与筛选，用户可开关) ---
  { key: 'rating', label: 'Ozon评级', type: 'number', required: false, interceptor: true, aliases: ['Ozon评级', 'Rating', '评分', 'Ozon'] },
  { key: 'deliveryTime', label: '时效 (天)', type: 'string', required: false, interceptor: true, aliases: ['时效限制', '时效', 'delivery time', '天'] },
  { key: 'minWeight', label: '最小实重 (g)', type: 'number', required: false, interceptor: true, aliases: ['货件重量限制 / 最小', '最小重量', 'min weight', '最小（克）'] },
  { key: 'maxWeight', label: '最大实重 (g)', type: 'number', required: false, interceptor: true, aliases: ['货件重量限制 / 最大', '最大重量', 'max weight', '最大（克）'] },
  { key: 'dimension', label: '尺寸限制', type: 'string', required: false, interceptor: true, aliases: ['尺寸限制', '尺寸限制，最大（厘米）', 'dimensions', '最大（厘米）', '边长总和'] },
  { key: 'valueRUB', label: '货值限制(卢布)', type: 'string', required: false, interceptor: true, aliases: ['货值限制/最低-最高（卢布）', '货值限制卢布', '卢布', 'rub', 'max value rub'] },
  { key: 'valueRMB', label: '货值限制(人民币)', type: 'string', required: false, interceptor: true, aliases: ['货值限制/最低-最高（人民币）', '货值限制人民币', '货值限制-人民币', '人民币', 'rmb', 'cny'] },
  { key: 'battery', label: '电池', type: 'boolean', required: false, interceptor: true, aliases: ['电池', 'battery'] },
  { key: 'liquid', label: '液体', type: 'boolean', required: false, interceptor: true, aliases: ['液体', 'liquid'] },
  
  // --- 计费与可选字段 ---
  { key: 'billingType', label: '计费类型', type: 'string', required: false, aliases: ['计费类型', 'billing', '实际重量'] },
  { key: 'volumetricDivisor', label: '体积重除数', type: 'number', required: false, aliases: ['体积重量计算方式', 'volumetric'] },
];

// 拦截配置类型
export interface InterceptionConfig {
  [key: string]: boolean; // 字段名 -> 是否启用
}

// ========================================================
// LOGISTICS_SCHEMA 智能映射函数
// ========================================================

/**
 * 标准化文本（小写、去空格、去标点）
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, "") // 保留字母、数字、中文
    .trim();
}

/**
 * 计算字符串相似度（编辑距离）
 */
function calculateSimilarity(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  
  if (len1 === 0 || len2 === 0) return 0;
  
  const matrix: number[][] = [];
  
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // 删除
        matrix[i][j - 1] + 1,      // 插入
        matrix[i - 1][j - 1] + cost // 替换
      );
    }
  }
  
  const distance = matrix[len1][len2];
  const maxLength = Math.max(len1, len2);
  return 1 - distance / maxLength;
}

/**
 * 基于 LOGISTICS_SCHEMA 自动创建映射
 */
export function createLogisticsMappings(headers: string[]): FieldMapping[] {
  const mappings: FieldMapping[] = [];
  
  for (const field of LOGISTICS_SCHEMA) {
    let bestMatch: { index: number; confidence: number } = { index: -1, confidence: 0 };
    
    // 遍历所有 CSV 列头，寻找最佳匹配
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (!header || header.trim() === "") continue;
      
      const normalizedHeader = normalizeText(header);
      
      // 使用同义词进行匹配
      for (const alias of field.aliases) {
        const normalizedAlias = normalizeText(alias);
        
        // 完全匹配
        if (normalizedHeader === normalizedAlias) {
          bestMatch = { index: i, confidence: 1.0 };
          break;
        }
        
        // 包含匹配
        if (normalizedHeader.includes(normalizedAlias) || normalizedAlias.includes(normalizedHeader)) {
          const score = 0.85;
          if (score > bestMatch.confidence) {
            bestMatch = { index: i, confidence: score };
          }
        }
        
        // 相似度匹配（编辑距离）
        const similarity = calculateSimilarity(normalizedHeader, normalizedAlias);
        if (similarity > 0.7 && similarity > bestMatch.confidence) {
          bestMatch = { index: i, confidence: similarity };
        }
      }
      
      if (bestMatch.confidence === 1.0) break; // 找到完全匹配，退出
    }
    
    // 🔹 默认拦截字段为启用状态
    const isInterceptor = field.interceptor === true;
    
    mappings.push({
      systemField: field.key,
      csvColumn: bestMatch.index >= 0 ? headers[bestMatch.index] : null,
      columnIndex: bestMatch.index,
      confidence: bestMatch.confidence,
      interceptionEnabled: isInterceptor, // 拦截字段默认开启
    });
  }
  
  devLog(`[LOGISTICS_SCHEMA] 自动映射完成: ${mappings.filter(m => m.columnIndex >= 0).length}/${mappings.length} 个字段匹配成功`);
  
  return mappings;
}

/**
 * 获取字段的中文标签
 */
export function getLogisticsFieldLabel(key: string): string {
  const field = LOGISTICS_SCHEMA.find(f => f.key === key);
  return field?.label || key;
}

/**
 * 检查字段是否为拦截字段
 */
export function isInterceptorField(key: string): boolean {
  const field = LOGISTICS_SCHEMA.find(f => f.key === key);
  return field?.interceptor === true;
}

// ========================================================
// 同义词库
// ========================================================

// 佣金表字段同义词
const COMMISSION_SYNONYMS: SynonymBank = {
  primaryCategory: [
    "一级类目", "主类目", "类目", "主类别", "一级类别",
    "primary category", "category", "main category", "type"
  ],
  secondaryCategory: [
    "二级类目", "子类目", "细分类目", "二级类别", "子类别",
    "secondary category", "sub category", "subcategory"
  ],
  tier1Rate: [
    "rfbs -> 0 - 1500 -> тариф, %", "rfbs 0-1500", "0-1500",
    "tier1", "c1", "第一阶梯", "第一档", "0-1500 佣金",
    "до 1500", "<1500", "阶梯1费率"
  ],
  tier2Rate: [
    "rfbs -> 1500.01 - 5000 -> тариф, %", "rfbs 1500-5000", "1500-5000",
    "tier2", "c2", "第二阶梯", "第二档", "1500-5000 佣金",
    "от 1500", "1500.01", "阶梯2费率"
  ],
  tier3Rate: [
    "rfbs -> 5000.01+ -> тариф, %", "rfbs 5000+", "5000+",
    "tier3", "c3", "第三阶梯", "第三档", ">5000 佣金",
    "от 5000", "5000.01+", "阶梯3费率"
  ],
};

// 物流表字段同义词
const SHIPPING_SYNONYMS: SynonymBank = {
  name: [
    "配送方式", "物流方式", "渠道名称", "运输方式",
    "shipping method", "channel", "provider", "carrier"
  ],
  thirdParty: [
    "第三方物流", "物流商", "承运商", "服务商",
    "third party", "logistics provider", "carrier"
  ],
  serviceLevel: [
    "服务等级", "物流等级", "配送等级",
    "service level", "tier", "level"
  ],
  rate: [
    "费率", "价格", "费用", "运费",
    "rate", "price", "fee", "cost", "тариф"
  ],
  minWeight: [
    "最小重量", "起重量", "重量下限",
    "min weight", "weight min", "最小克数"
  ],
  maxWeight: [
    "最大重量", "重量上限", "限重",
    "max weight", "weight max", "最大克数"
  ],
  maxLength: [
    "最大长度", "长度限制", "长边限制",
    "max length", "length limit"
  ],
  maxWidth: [
    "最大宽度", "宽度限制",
    "max width", "width limit"
  ],
  maxHeight: [
    "最大高度", "高度限制",
    "max height", "height limit"
  ],
  deliveryTime: [
    "时效", "配送时效", "运输时间", "时效限制",
    "delivery time", "shipping time", "transit time"
  ],
  // 🔹 新增：尺寸限制约束字段
  dimension: [
    "尺寸限制", "最大尺寸", "边长总和", "尺寸约束",
    "dimensions", "size limit", "dimension limit", "size constraints",
    "体积限制", "包装限制"
  ],
  // 🔹 新增：电池和液体属性字段
  battery: [
    "电池", "是否带电", "电池限制", "电池属性",
    "battery", "battery allowed", "battery limit"
  ],
  liquid: [
    "液体", "是否带液体", "液体限制", "液体属性",
    "liquid", "liquid allowed", "liquid limit"
  ],
  // 🔹 新增：货值限制字段
  valueRUB: [
    "货值限制/最低-最高（卢布）", "货值限制卢布", "货值限制（卢布）", "卢布",
    "max value rub", "value rub", "rub"
  ],
  valueRMB: [
    "货值限制/最低-最高（人民币）", "货值限制人民币", "货值限制-人民币", "人民币",
    "max value rmb", "value rmb", "cny", "rmb"
  ],
};

// ========================================================
// 核心解析函数
// ========================================================

/**
 * 模糊匹配表头
 * 使用同义词库进行模糊匹配
 */
export function fuzzyMatchHeader(
  header: string,
  synonyms: SynonymBank
): { field: string; confidence: number } | null {
  const normalizedHeader = normalizeText(header);
  
  let bestMatch: { field: string; confidence: number } | null = null;
  let bestScore = 0;
  
  for (const [field, synonymList] of Object.entries(synonyms)) {
    for (const synonym of synonymList) {
      const normalizedSynonym = normalizeText(synonym);
      
      // 完全匹配
      if (normalizedHeader === normalizedSynonym) {
        return { field, confidence: 1.0 };
      }
      
      // 包含匹配
      if (normalizedHeader.includes(normalizedSynonym) || normalizedSynonym.includes(normalizedHeader)) {
        const score = 0.8;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { field, confidence: score };
        }
      }
      
      // 相似度匹配（编辑距离）
      const similarity = calculateSimilarity(normalizedHeader, normalizedSynonym);
      if (similarity > 0.7 && similarity > bestScore) {
        bestScore = similarity;
        bestMatch = { field, confidence: similarity };
      }
    }
  }
  
  return bestMatch;
}

/**
 * 语义预判：扫描列数据特征
 */
export function predictColumnDataType(
  columnData: string[],
  rowIndex: number = 10
): { type: string; confidence: number; label?: string } {
  const sample = columnData.slice(0, rowIndex);
  
  // 百分比检测
  if (sample.every(cell => /^\s*\d+\.?\d*\s*%\s*$/.test(cell) || cell === "" || cell === "-")) {
    return { type: "percentage", confidence: 0.9, label: "疑似佣金率" };
  }
  
  // 数值区间检测
  if (sample.every(cell => /\d+\s*[-–—]\s*\d+/.test(cell) || cell === "" || cell === "-")) {
    return { type: "range", confidence: 0.85, label: "疑似价格区间" };
  }
  
  // 纯数字检测
  const numericCells = sample.filter(cell => /^\s*\d+\.?\d*\s*$/.test(cell));
  if (numericCells.length / sample.length > 0.8) {
    return { type: "number", confidence: 0.7, label: "疑似数值" };
  }
  
  // 类目词检测
  const categoryKeywords = ["电子", "服装", "家居", "美容", "儿童", "运动", "宠物", "食品", "医疗", "汽车"];
  const matchCount = sample.filter(cell => 
    categoryKeywords.some(keyword => cell.includes(keyword))
  ).length;
  
  if (matchCount / sample.length > 0.5) {
    return { type: "category", confidence: 0.85, label: "疑似类目" };
  }
  
  // 物流商检测
  const carrierKeywords = ["邮政", "快递", "物流", "express", "post", "logistics"];
  const carrierMatchCount = sample.filter(cell => 
    carrierKeywords.some(keyword => cell.toLowerCase().includes(keyword))
  ).length;
  
  if (carrierMatchCount / sample.length > 0.5) {
    return { type: "carrier", confidence: 0.85, label: "疑似物流商" };
  }
  
  return { type: "unknown", confidence: 0 };
}

/**
 * 智能解析 CSV 文件
 */
export function smartParseCSV(
  csvContent: string,
  type: "commission" | "shipping"
): ParsedData {
  const warnings: string[] = [];
  const errors: string[] = [];
  
  try {
    // 1. 解析 CSV
    const lines = csvContent.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) {
      errors.push("文件内容不足：至少需要表头行和一行数据");
      return {
        headers: [],
        rows: [],
        mappings: [],
        recognizedCount: 0,
        totalCount: 0,
        warnings,
        errors,
      };
    }
    
    // 2. 查找真实表头行
    const headerRowIndex = findHeaderRow(lines, type);
    const headers = parseCSVLine(lines[headerRowIndex]);
    
    // 🔹 健壮性保护：检查表头是否为空
    if (!headers || headers.length === 0) {
      errors.push("未能识别有效的表头行");
      return {
        headers: [],
        rows: [],
        mappings: [],
        recognizedCount: 0,
        totalCount: 0,
        warnings,
        errors,
      };
    }
    
    const dataRows = lines.slice(headerRowIndex + 1).map(line => parseCSVLine(line));
    
    // 🔹 健壮性保护：确保每行列数一致，缺失的用空字符串填充
    const normalizedRows = dataRows.map(row => {
      const normalizedRow = [...row];
      while (normalizedRow.length < headers.length) {
        normalizedRow.push(""); // 填充缺失的列
      }
      return normalizedRow;
    });
    
    // 3. 选择同义词库
    const synonyms = type === "commission" ? COMMISSION_SYNONYMS : SHIPPING_SYNONYMS;
    
    // 🔹 4. 智能匹配字段（物流表使用 LOGISTICS_SCHEMA）
    let mappings: FieldMapping[];
    
    if (type === "shipping") {
      // 物流表使用新的 LOGISTICS_SCHEMA
      mappings = createLogisticsMappings(headers);
    } else {
      // 佣金表使用旧的同义词库
      mappings = Object.keys(synonyms).map(systemField => {
        let bestMatch: FieldMapping = {
          systemField,
          csvColumn: null,
          columnIndex: -1,
          confidence: 0,
        };
        
        // 遍历所有列，寻找最佳匹配
        for (let i = 0; i < headers.length; i++) {
          const match = fuzzyMatchHeader(headers[i], { [systemField]: synonyms[systemField] });
          
          if (match && match.confidence > bestMatch.confidence) {
            bestMatch = {
              systemField,
              csvColumn: headers[i],
              columnIndex: i,
              confidence: match.confidence,
            };
          }
        }
        
        return bestMatch;
      });
    }
    
    // 5. 统计识别结果
    const recognizedCount = mappings.filter(m => m.confidence >= 0.7).length;
    const totalCount = mappings.length;
    
    if (recognizedCount < totalCount) {
      warnings.push(`已自动识别 ${recognizedCount}/${totalCount} 个核心字段，请检查未识别字段`);
    }
    
    // 🔹 6. 物流表特殊处理：提取尺寸约束
    let parsedConstraints: Map<string, SizeConstraints> | undefined;
    
    if (type === "shipping") {
      const sizeMapping = mappings.find(m => m.systemField === "dimension");
      
      if (sizeMapping && sizeMapping.columnIndex >= 0) {
        parsedConstraints = new Map();
        
        normalizedRows.forEach((row, index) => {
          const cellValue = row[sizeMapping.columnIndex];
          
          if (cellValue && cellValue.trim() !== "" && cellValue !== "-") {
            const constraints = parseSizeConstraints(cellValue);
            
            // 只有解析成功才存储
            if (constraints.maxSum !== null || constraints.maxLongEdge !== null) {
              parsedConstraints!.set(`row_${index}`, constraints);
            }
          }
        });
        
        devLog(`✅ 成功解析 ${parsedConstraints.size} 个物流渠道的尺寸约束`);
      }
    }
    
    return {
      headers,
      rows: normalizedRows,
      mappings,
      recognizedCount,
      totalCount,
      warnings,
      errors,
      parsedConstraints,
    };
    
  } catch (error) {
    errors.push(`解析失败: ${error instanceof Error ? error.message : "未知错误"}`);
    return {
      headers: [],
      rows: [],
      mappings: [],
      recognizedCount: 0,
      totalCount: 0,
      warnings,
      errors,
    };
  }
}

/**
 * 校验数据合法性
 */
export function validateData(
  parsedData: ParsedData
): { isValid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 检查必填字段
  const requiredFields = ["primaryCategory", "secondaryCategory", "tier1Rate", "tier2Rate", "tier3Rate"];
  for (const field of requiredFields) {
    const mapping = parsedData.mappings.find(m => m.systemField === field);
    if (!mapping || mapping.columnIndex === -1) {
      errors.push(`缺少必填字段: ${field}`);
    }
  }
  
  // 检查数据行
  if (parsedData.rows.length === 0) {
    errors.push("没有找到数据行");
  }
  
  // 检查数值合法性
  for (let i = 0; i < parsedData.rows.length; i++) {
    const row = parsedData.rows[i];
    
    for (const mapping of parsedData.mappings) {
      const value = row[mapping.columnIndex];
      
      if (!value || value.trim() === "" || value === "-") {
        continue; // 允许空值
      }
      
      // 检查百分比格式
      if (mapping.systemField.includes("Rate")) {
        if (!/^\s*\d+\.?\d*\s*%?\s*$/.test(value)) {
          warnings.push(`第 ${i + 2} 行，列 "${mapping.csvColumn}": "${value}" 不是有效的百分比`);
        }
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings: [...warnings, ...parsedData.warnings],
  };
}

// ========================================================
// 🔹 尺寸约束解析器
// ========================================================

export interface SizeConstraints {
  maxSum: number | null;        // 边长总和限制 (cm)
  maxLongEdge: number | null;   // 长边限制 (cm)
  rawText: string;              // 原始文本
}

/**
 * 从非结构化文本中提取尺寸约束
 */
export function parseSizeConstraints(text: string): SizeConstraints {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  
  // 提取边长总和限制
  const sumPatterns = [
    /边长总和\s*[≤<=]\s*(\d+)/i,
    /尺寸总和\s*[≤<=]\s*(\d+)/i,
    /三边总和\s*[≤<=]\s*(\d+)/i,
    /sum\s*[≤<=]\s*(\d+)/i,
    /总尺寸\s*[≤<=]\s*(\d+)/i,
  ];
  
  let maxSum: number | null = null;
  for (const pattern of sumPatterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      maxSum = parseInt(match[1], 10);
      break;
    }
  }
  
  // 提取长边限制
  const edgePatterns = [
    /长边\s*[≤<=]\s*(\d+)/i,
    /最长边\s*[≤<=]\s*(\d+)/i,
    /最大边\s*[≤<=]\s*(\d+)/i,
    /max\s*length\s*[≤<=]\s*(\d+)/i,
    /长度\s*[≤<=]\s*(\d+)/i,
  ];
  
  let maxLongEdge: number | null = null;
  for (const pattern of edgePatterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      maxLongEdge = parseInt(match[1], 10);
      break;
    }
  }
  
  // 🔹 打印解析结果
  if (maxSum !== null || maxLongEdge !== null) {
    devLog(`📏 尺寸约束解析成功:`, {
      原文: normalizedText,
      边长总和: maxSum ? `${maxSum}cm` : '未识别',
      长边限制: maxLongEdge ? `${maxLongEdge}cm` : '未识别',
    });
  }
  
  return {
    maxSum,
    maxLongEdge,
    rawText: normalizedText,
  };
}

/**
 * 验证尺寸是否符合约束
 */
export function validateSizeConstraints(
  length: number,
  width: number,
  height: number,
  constraints: SizeConstraints
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // 计算边长总和
  const sum = length + width + height;
  
  // 找出长边
  const longEdge = Math.max(length, width, height);
  
  // 检查边长总和限制
  if (constraints.maxSum !== null && sum > constraints.maxSum) {
    errors.push(`边长总和超限：当前 ${sum}cm，限制 ${constraints.maxSum}cm`);
  }
  
  // 检查长边限制
  if (constraints.maxLongEdge !== null && longEdge > constraints.maxLongEdge) {
    errors.push(`长边超限：当前 ${longEdge}cm，限制 ${constraints.maxLongEdge}cm`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * 查找真实表头行
 */
function findHeaderRow(lines: string[], type: "commission" | "shipping"): number {
  const keywords = type === "commission" 
    ? ["一级类目", "secondary category", "primary category", "类目"]
    : ["配送方式", "物流商", "shipping", "provider", "渠道"];
  
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (line.includes(keyword.toLowerCase())) {
        return i;
      }
    }
  }
  
  return 0; // 默认第一行
}

/**
 * 解析 CSV 行（处理引号和逗号）
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

/**
 * 保存映射关系到 localStorage
 */
export function saveMappingToHistory(
  fileName: string,
  mappings: FieldMapping[],
  type: "commission" | "shipping"
): void {
  try {
    const key = type === "commission" ? "ozon_commission_mappings" : "ozon_shipping_mappings";
    const history = JSON.parse(localStorage.getItem(key) || "{}");
    
    // 提取表头特征
    const headerSignature = mappings.map(m => m.csvColumn).join(",");
    
    history[headerSignature] = {
      fileName,
      mappings,
      timestamp: Date.now(),
    };
    
    localStorage.setItem(key, JSON.stringify(history));
  } catch (error) {
    console.error("保存映射历史失败:", error);
  }
}

/**
 * 从 localStorage 加载映射关系
 */
export function loadMappingFromHistory(
  headers: string[],
  type: "commission" | "shipping"
): FieldMapping[] | null {
  try {
    const key = type === "commission" ? "ozon_commission_mappings" : "ozon_shipping_mappings";
    const history = JSON.parse(localStorage.getItem(key) || "{}");
    
    const headerSignature = headers.join(",");
    
    if (history[headerSignature]) {
      return history[headerSignature].mappings;
    }
    
    return null;
  } catch (error) {
    console.error("加载映射历史失败:", error);
    return null;
  }
}
