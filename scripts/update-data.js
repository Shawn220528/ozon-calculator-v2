/**
 * 数据更新脚本
 * 从 CSV 文件读取数据并生成 TypeScript 常量
 */

const fs = require('fs');
const path = require('path');

// 解析费率字符串
function parseShippingRateString(rateStr) {
  if (!rateStr || rateStr.trim() === '-' || rateStr.trim() === '') {
    return { fixFee: 0, varFeePerGram: 0 };
  }

  const result = { fixFee: 0, varFeePerGram: 0 };

  try {
    let cleaned = rateStr
      .replace(/,/g, '.')
      .replace(/[¥￥$€₽]/gi, '')
      .replace(/rmb|cny|rub|rubles?|元|卢布/gi, '')
      .replace(/人民币|固定费|变动费|价格|费用|成本/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    const varPatterns = [
      /(\d+\.?\d*)\s*\/\s*1\s*[gгкkg]/i,
      /(\d+\.?\d*)\s*\/\s*[gгкkg]/i,
      /(\d+\.?\d*)\s*(?:每|per)\s*[gгкkg]/i,
    ];

    for (const pattern of varPatterns) {
      const match = cleaned.match(pattern);
      if (match) {
        result.varFeePerGram = parseFloat(match[1]);
        cleaned = cleaned.replace(pattern, '');
        break;
      }
    }

    const fixedMatch = cleaned.match(/(\d+\.?\d*)/);
    if (fixedMatch) {
      result.fixFee = parseFloat(fixedMatch[1]);
    }

    if (result.fixFee === 0 && result.varFeePerGram === 0) {
      const numbers = rateStr.match(/\d+\.?\d*/g);
      if (numbers && numbers.length >= 1) {
        result.fixFee = parseFloat(numbers[0]);
        if (numbers.length >= 2) {
          result.varFeePerGram = parseFloat(numbers[1]);
        }
      }
    }
  } catch (error) {
    console.warn(`[费率解析警告] 无法解析: "${rateStr}"`);
  }

  return result;
}

// 解析尺寸限制
function parseDimensionString(dimStr) {
  const result = { maxSum: 999, maxLength: 999 };

  if (!dimStr || dimStr.trim() === '') return result;

  const sumMatch = dimStr.match(/总和\s*[≤<=]\s*(\d+)/);
  if (sumMatch) {
    result.maxSum = parseInt(sumMatch[1]);
  }

  const lengthMatch = dimStr.match(/长边\s*[≤<=]\s*(\d+)/);
  if (lengthMatch) {
    result.maxLength = parseInt(lengthMatch[1]);
  }

  return result;
}

// 解析货值范围
function parseValueRange(valStr) {
  if (!valStr || valStr.trim() === '' || valStr.trim() === '-') {
    return { min: 0, max: 999999 };
  }

  // 移除逗号（如 "30,000"）
  const cleaned = valStr.replace(/,/g, '');
  
  const match = cleaned.match(/([\d.]+)\s*[-–—]\s*([\d.]+)/);
  if (match) {
    return { min: parseFloat(match[1]), max: parseFloat(match[2]) };
  }

  const singleNum = cleaned.match(/([\d.]+)/);
  if (singleNum) {
    return { min: 0, max: parseFloat(singleNum[1]) };
  }

  return { min: 0, max: 999999 };
}

// 解析时效
function parseDeliveryTime(timeStr) {
  if (!timeStr || timeStr.trim() === '') {
    return { min: 20, max: 40 };
  }

  const normalizeRange = (a, b) => {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    return min > 0 && max <= 120 ? { min, max } : { min: 20, max: 40 };
  };

  const value = String(timeStr).trim();

  const dateTokens = value.match(/\d+/g)?.map((token) => parseInt(token, 10)) || [];
  if (dateTokens.length >= 3) {
    const [first, second, third] = dateTokens;
    if (first >= 1900 && second >= 1 && second <= 120 && third >= 1 && third <= 120) {
      return normalizeRange(second, third);
    }
    if ((third >= 1900 || third <= 99) && first >= 1 && first <= 120 && second >= 1 && second <= 120) {
      return normalizeRange(first, second);
    }
  }

  const match = value.match(/(\d{1,3})\s*(?:[-–—~至到]|\.{2})\s*(\d{1,3})/);
  if (match) {
    return normalizeRange(parseInt(match[1], 10), parseInt(match[2], 10));
  }

  const chineseDateLike = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/);
  if (chineseDateLike) {
    return normalizeRange(parseInt(chineseDateLike[1], 10), parseInt(chineseDateLike[2], 10));
  }

  if (dateTokens.length === 2 && /[/.]/.test(value)) {
    return normalizeRange(dateTokens[0], dateTokens[1]);
  }

  const singleNum = value.match(/(\d{1,3})/);
  if (singleNum) {
    const days = parseInt(singleNum[1], 10);
    if (days > 0 && days <= 120) {
      return { min: days, max: days };
    }
  }

  return { min: 20, max: 40 };
}

// 解析佣金CSV
function parseCommissionCSV(csvContent) {
  const lines = csvContent.split('\n');
  const commissions = [];

  // 找到表头行
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].includes('一级类目') && lines[i].includes('二级类目')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.error('未找到佣金表头行');
    return [];
  }

  // 解析数据行
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 使用更智能的CSV解析（处理引号内的逗号）
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    if (values.length < 5) continue;

    const primary = values[0];
    const secondary = values[1];
    
    if (!primary || !secondary) continue;

    // 解析三个阶梯费率
    const tier1Str = values[2] || '12%';
    const tier2Str = values[3] || '15%';
    const tier3Str = values[4] || '18%';

    const parsePercent = (str) => {
      return parseFloat(str.replace('%', '').replace(',', '.').trim()) || 0;
    };

    commissions.push({
      primaryCategory: primary,
      secondaryCategory: secondary,
      tiers: [
        { min: 0, max: 1500, rate: parsePercent(tier1Str) },
        { min: 1500.01, max: 5000, rate: parsePercent(tier2Str) },
        { min: 5000.01, max: Infinity, rate: parsePercent(tier3Str) },
      ],
    });
  }

  return commissions;
}

// 解析物流CSV
function parseShippingCSV(csvContent) {
  const lines = csvContent.split('\n');
  const channels = [];
  const idCounter = new Map();

  // 找到表头行
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].includes('配送方式') && lines[i].includes('第三方物流')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.error('未找到物流表头行');
    return [];
  }

  // 解析数据行
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // CSV解析
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    if (values.length < 10) continue;

    const name = values[3]; // 配送方式
    if (!name || name === '-' || name === '') continue;

    const serviceTier = values[0]; // 评分组
    const serviceLevel = values[1]; // 服务等级
    const thirdParty = values[2]; // 第三方物流
    const rating = parseFloat(values[4]) || 0; // Ozon评级
    const timeStr = values[5]; // 时效限制
    const rateStr = values[6]; // 费率
    const battery = values[7]; // 电池
    const liquid = values[8]; // 液体
    const dimStr = values[9]; // 尺寸限制
    const minWeight = parseFloat(values[10]) || 0;
    const maxWeight = parseFloat(values[11].replace(/,/g, '')) || 999999;
    const valRUB = parseValueRange(values[13]);
    const valRMB = parseValueRange(values[14]);

    // 生成唯一ID
    const baseId = `${name.trim().toLowerCase().replace(/\s+/g, '-')}_${(serviceLevel || '').trim().toLowerCase().replace(/\s+/g, '-')}`;
    const count = idCounter.get(baseId) || 0;
    const uniqueId = count > 0 ? `${baseId}_${count + 1}` : baseId;
    idCounter.set(baseId, count + 1);

    // 解析费率
    const { fixFee, varFeePerGram } = parseShippingRateString(rateStr);

    // 解析尺寸
    const { maxSum, maxLength } = parseDimensionString(dimStr);

    // 解析时效
    const { min: dmin, max: dmax } = parseDeliveryTime(timeStr);

    channels.push({
      id: uniqueId,
      name,
      thirdParty: thirdParty || '',
      serviceTier: serviceTier || '',
      serviceLevel: serviceLevel || '',
      fixFee,
      varFeePerGram,
      pricePerKg: fixFee + varFeePerGram * 1000,
      pricePerCubic: 0,
      minWeight,
      maxWeight,
      maxLength,
      maxWidth: maxLength,
      maxHeight: maxLength,
      maxSumDimension: maxSum,
      deliveryTimeMin: dmin,
      deliveryTimeMax: dmax,
      deliveryTime: Math.round((dmin + dmax) / 2),
      maxValueRUB: valRUB.max,
      maxValue: valRMB.max,
      billingType: '实际重量',
      volumetricDivisor: 0,
      ozonRating: rating,
      batteryAllowed: battery?.includes('允许') || battery?.toLowerCase().includes('allow') || false,
      liquidAllowed: liquid?.includes('允许') || liquid?.toLowerCase().includes('allow') || false,
    });
  }

  return channels;
}

// 生成TypeScript代码
function generateTypeScriptCode(commissions, channels) {
  // 自定义JSON序列化,正确处理Infinity
  const jsonReplacer = (key, value) => {
    if (value === Infinity) return 'Infinity';
    return value;
  };

  const commissionStr = JSON.stringify(commissions, jsonReplacer, 2)
    .replace(/"Infinity"/g, 'Infinity');
  const channelStr = JSON.stringify(channels, jsonReplacer, 2)
    .replace(/"Infinity"/g, 'Infinity');

  return `// ========================================================
// 自动生成的数据文件 (更新时间: ${new Date().toLocaleString('zh-CN')})
// 数据来源:
//   - 佣金数据: Tarifs_CN_01_12_2025_1761720496.csv
//   - 物流数据: China_scoring_ENG_CN_7_04_26_1775544002.csv
// ========================================================

import { CategoryCommission, ShippingChannel } from './types';

export const DEFAULT_COMMISSION_DATA: CategoryCommission[] = ${commissionStr};

export const DEFAULT_SHIPPING_DATA: ShippingChannel[] = ${channelStr};
`;
}

// 主函数
async function main() {
  try {
    console.log('开始更新数据...\n');

    // 读取CSV文件
    const commissionCSVPath = path.join(__dirname, '../../Tarifs_CN_01_12_2025_1761720496.csv');
    const shippingCSVPath = path.join(__dirname, '../../China_scoring_ENG_CN_7_04_26_1775544002.csv');

    console.log('读取佣金数据:', commissionCSVPath);
    const commissionCSV = fs.readFileSync(commissionCSVPath, 'utf-8');
    
    console.log('读取物流数据:', shippingCSVPath);
    const shippingCSV = fs.readFileSync(shippingCSVPath, 'utf-8');

    // 解析数据
    console.log('\n解析佣金数据...');
    const commissions = parseCommissionCSV(commissionCSV);
    console.log(`✓ 成功解析 ${commissions.length} 条佣金数据`);

    console.log('\n解析物流数据...');
    const channels = parseShippingCSV(shippingCSV);
    console.log(`✓ 成功解析 ${channels.length} 条物流数据`);

    // 生成TypeScript代码
    console.log('\n生成TypeScript代码...');
    const tsCode = generateTypeScriptCode(commissions, channels);

    // 写入文件
    const outputPath = path.join(__dirname, '../lib/default-data.ts');
    fs.writeFileSync(outputPath, tsCode, 'utf-8');
    console.log(`✓ 已生成: ${outputPath}`);

    console.log('\n✅ 数据更新完成!');
    console.log('\n接下来需要手动更新:');
    console.log('1. 打开 lib/data-hub-context.tsx');
    console.log('2. 导入新生成的数据: import { DEFAULT_COMMISSION_DATA, DEFAULT_SHIPPING_DATA } from "./default-data";');
    console.log('3. 删除文件中的 DEFAULT_COMMISSION_DATA 和 DEFAULT_SHIPPING_DATA 常量定义');

  } catch (error) {
    console.error('❌ 更新失败:', error);
    process.exit(1);
  }
}

main();
