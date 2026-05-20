/**
 * 物流字段映射注册表 (Schema Registry)
 * 所有 CSV 字段映射必须通过此注册表进行，禁止硬编码
 */

export interface FieldSchema {
  key: string;                    // 系统内部字段名
  label: string;                  // 中文标签
  aliases: string[];              // CSV 列名别名（用于模糊匹配）
  type: 'text' | 'number' | 'price-range' | 'dimension-nlp' | 'weight-range' | 'boolean';
  required: boolean;              // 是否必填
  defaultValue?: any;             // 默认值
  description?: string;           // 字段说明
}

/**
 * 物流字段注册表
 * 以后所有解析器只引用 key，不引用中文名
 */
export const LOGISTICS_FIELDS: FieldSchema[] = [
  {
    key: 'name',
    label: '配送方式',
    aliases: ['配送方式', '物流名称', 'method name', 'delivery method', 'name', '物流方式', '配送方式名称'],
    type: 'text',
    required: true,
    description: '物流渠道名称'
  },
  {
    key: 'serviceLevel',
    label: '服务等级',
    aliases: ['服务等级', '等级', 'level', 'service level', 'тип'],
    type: 'text',
    required: false,
    defaultValue: '标准服务'
  },
  {
    key: 'serviceTier',
    label: '评分组',
    aliases: ['评分组', 'scoring group', '服务组', 'tier', 'service tier', 'service group', 'группа'],
    type: 'text',
    required: false
  },
  {
    key: 'thirdParty',
    label: '第三方物流',
    aliases: ['第三方物流', '3PL', '物流商', 'carrier', 'third party', 'логист'],
    type: 'text',
    required: false
  },
  {
    key: 'rating',
    label: 'Ozon评级',
    aliases: ['Ozon评级', '评级', '评分', 'rating', 'ozon rating', 'рейтинг'],
    type: 'number',
    required: false,
    defaultValue: 0
  },
  {
    key: 'deliveryTime',
    label: '时效',
    aliases: ['时效', '时效(天)', 'time-limits', 'delivery time', 'срок', 'Delivery time', '配送时间'],
    type: 'text',
    required: false,
    defaultValue: '5-14'
  },
  {
    key: 'rate',
    label: '费率',
    aliases: ['费率', '费率(固定+变动)', 'rates (pudo / courier)', 'rates', 'rate', 'ставка', '价格'],
    type: 'text',
    required: true,
    description: '格式: ¥固定费 + ¥每克变动费/1g'
  },
  {
    key: 'battery',
    label: '电池',
    aliases: ['电池', '允许电池', 'battery', 'batteries', 'батарея', 'Has battery', '带电池'],
    type: 'boolean',
    required: false,
    defaultValue: false
  },
  {
    key: 'liquid',
    label: '液体',
    aliases: ['液体', '允许液体', 'liquid', 'liquids', 'жидкость', 'Has liquid', '带液体'],
    type: 'boolean',
    required: false,
    defaultValue: false
  },
  {
    key: 'dimension',
    label: '尺寸限制',
    aliases: [
      '尺寸限制', '尺寸限制，最大（厘米）', 'размер', 
      'dimension', 'dimensions', 'size limit',
      'measurements, max cm', '尺寸', '长度限制', 'Max length, cm', 'Length'
    ],
    type: 'dimension-nlp',
    required: false,
    description: 'NLP格式: "边长总和≤90cm,长边≤60cm"'
  },
  {
    key: 'minWeight',
    label: '最小重量',
    aliases: [
      '最小重量', '重量限制 / 最小（克）', 'min weight', 'minimum', 'мин вес',
      'shipment weight limits / min g', 'Min weight, g', '最小重量 (g)', '最低重量'
    ],
    type: 'number',
    required: false,
    defaultValue: 1
  },
  {
    key: 'maxWeight',
    label: '最大重量',
    aliases: [
      '最大重量', '重量限制 / 最大（克）', 'max weight', 'maximum', 'макс вес',
      'shipment weight limits / max g', 'Max weight, g', '最大重量 (g)', '最高重量'
    ],
    type: 'number',
    required: false,
    defaultValue: 999999
  },
  {
    key: 'valueRUB',
    label: '货值限制(卢布)',
    aliases: [
      '货值限制/最低-最高（卢布）', '货值限制（卢布）', '货值限制卢布', '卢布', 'rub',
      'shipment cost limit / min-max rub',
      'max value rub', 'max price rub', 'Макс. сумма заказа, ₽',
      '最大订单金额', 'Max price', '最大价格', '货值限制卢布'
    ],
    type: 'price-range',
    required: false,
    description: '格式: "1501 - 7000"'
  },
  {
    key: 'valueRMB',
    label: '货值限制(人民币)',
    aliases: [
      '货值限制/最低-最高（人民币）', '货值限制（人民币）', '货值限制-人民币', '货值限制人民币', '人民币', 'rmb', 'cny',
      'shipment cost limit / min-max cny',
      'max value', 'max amount', 'макс сумма'
    ],
    type: 'price-range',
    required: false
  },
  {
    key: 'billingType',
    label: '计费类型',
    aliases: ['计费类型', '计费方式', 'tarification type', 'billing type', 'type', 'тип оплаты'],
    type: 'text',
    required: false,
    defaultValue: '实际重量'
  },
  {
    key: 'volumetricDivisor',
    label: '体积重除数',
    aliases: [
      '体积重量计算方式', '体积重除数', '除数', 'divisor', 'коэффициент',
      'volume weight calculation', 'Volumetric coefficient', '体积系数', '体积重量'
    ],
    type: 'text',
    required: false,
    defaultValue: 12000,
    description: '从字符串中提取数字，如 "÷12000"'
  }
];

/**
 * 根据 key 获取字段定义
 */
export function getFieldSchema(key: string): FieldSchema | undefined {
  return LOGISTICS_FIELDS.find(f => f.key === key);
}

/**
 * 根据 key 获取字段标签
 */
export function getFieldLabel(key: string): string {
  return getFieldSchema(key)?.label || key;
}

/**
 * 获取所有字段的 key 列表
 */
export function getAllFieldKeys(): string[] {
  return LOGISTICS_FIELDS.map(f => f.key);
}

/**
 * 匹配 CSV 列名到字段 key
 * @param header CSV 列名
 * @returns 匹配到的字段 key，未匹配返回 null
 */
export function matchHeaderToField(header: string): string | null {
  const normalizedHeader = header.trim().toLowerCase();
  
  for (const field of LOGISTICS_FIELDS) {
    for (const alias of field.aliases) {
      if (
        normalizedHeader.includes(alias.toLowerCase()) ||
        alias.toLowerCase().includes(normalizedHeader)
      ) {
        return field.key;
      }
    }
  }
  
  return null;
}

/**
 * 为所有 CSV 表头生成映射
 * @param headers CSV 表头数组
 * @returns 字段 key 到列索引的映射
 */
export function buildColumnMapping(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const diagnostics: Array<{ header: string; matchedField: string | null; index: number }> = [];
  
  headers.forEach((header, index) => {
    const matchedField = matchHeaderToField(header);
    diagnostics.push({ header, matchedField, index });
    
    if (matchedField && !(matchedField in mapping)) {
      mapping[matchedField] = index;
    }
  });
  
  return mapping;
}
