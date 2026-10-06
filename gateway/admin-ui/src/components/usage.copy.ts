/** Shared usage copy: metering and pricing badges plus the quota summary used across admin pages. */

export const zh = {
  meteringComplete: '完整',
  meteringMissing: '缺失 {count} 次',
  pricingNone: '暂无价格数据',
  pricingPriced: '价格已配置',
  pricingZero: '价格为 0',
  pricingUnpriced: '未配置价格',
  pricingHistoricalUnknown: '历史价格未知',
  pricingPartial: '价格部分缺失',
  quotaCost: '成本',
  alertTokens: 'Token',
  alertCost: '成本',
  quotaNoLimit: '不限',
} satisfies Record<string, string>

/** Shared usage locale key union. */
export type UsageCopyKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  meteringComplete: 'Complete',
  meteringMissing: '{count} missing',
  pricingNone: 'No pricing data',
  pricingPriced: 'Priced',
  pricingZero: 'Price is 0',
  pricingUnpriced: 'Unpriced',
  pricingHistoricalUnknown: 'Historical pricing unknown',
  pricingPartial: 'Pricing partially missing',
  quotaCost: 'Cost',
  alertTokens: 'Tokens',
  alertCost: 'Cost',
  quotaNoLimit: 'Unlimited',
} satisfies Record<UsageCopyKey, string>
