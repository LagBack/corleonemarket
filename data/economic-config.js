// ── Economic System Configuration ───────────────────────────────────────
// All rates are configurable — change here without touching logic code.
// Rates expressed as decimals: 0.02 = 2%

const DAILY_MAINTENANCE_BRACKETS = [
  { min: 0,           max: 1_000_000,     rate: 0.0020 },   // up to 1M       → 0.20%
  { min: 1_000_000,   max: 5_000_000,     rate: 0.0035 },   // 1M–5M          → 0.35%
  { min: 5_000_000,   max: 10_000_000,    rate: 0.0050 },   // 5M–10M         → 0.50%
  { min: 10_000_000,  max: 25_000_000,    rate: 0.0075 },   // 10M–25M        → 0.75%
  { min: 25_000_000,  max: 50_000_000,    rate: 0.0100 },   // 25M–50M        → 1.00%
  { min: 50_000_000,  max: 100_000_000,   rate: 0.0125 },   // 50M–100M       → 1.25%
  { min: 100_000_000, max: Infinity,      rate: 0.0150 },   // above 100M     → 1.50%
];

const WEALTH_TAX_BRACKETS = [
  { min: 0,            max: 5_000_000,     rate: 0.02 },    // up to 5M         → 2%
  { min: 5_000_000,   max: 25_000_000,    rate: 0.04 },    // 5M–25M           → 4%
  { min: 25_000_000,  max: 100_000_000,   rate: 0.06 },    // 25M–100M         → 6%
  { min: 100_000_000, max: Infinity,       rate: 0.08 },    // above 100M       → 8%
];

module.exports = {
  // Trading fees
  buyFeeRate:   0.02,      // 2% on buy orders
  sellFeeRate:  0.03,      // 3% on sell orders

  // Daily maintenance fee brackets (progressive — applies single bracket based on total net worth)
  dailyMaintenanceBrackets: DAILY_MAINTENANCE_BRACKETS,

  // Wealth tax brackets (progressive — applies single bracket based on total net worth)
  wealthTaxBrackets: WEALTH_TAX_BRACKETS,

  // Cycle length for wealth tax (in days)
  wealthTaxCycleDays: 15,

  // ── Calculation helpers ──────────────────────────────────────

  /** Find the applicable rate bracket for a given net worth */
  findBracket(netWorth, brackets) {
    for (const b of brackets) {
      if (netWorth >= b.min && netWorth < b.max) return b;
    }
    // Fallback to last bracket
    return brackets[brackets.length - 1];
  },

  /** Calculate daily maintenance fee for a given net worth */
  calculateDailyMaintenance(netWorth) {
    const bracket = this.findBracket(netWorth, DAILY_MAINTENANCE_BRACKETS);
    return Math.round(netWorth * bracket.rate * 100) / 100;
  },

  /** Calculate wealth tax for a given net worth */
  calculateWealthTax(netWorth) {
    const bracket = this.findBracket(netWorth, WEALTH_TAX_BRACKETS);
    return Math.round(netWorth * bracket.rate * 100) / 100;
  },

  /** Calculate trading fee for an order */
  calculateTradingFee(tradeValue, orderType) {
    const rate = orderType === 'buy' ? this.buyFeeRate : this.sellFeeRate;
    return Math.round(tradeValue * rate * 100) / 100;
  },

  /** Get human-readable label for a maintenance fee bracket */
  getMaintenanceBracketLabel(netWorth) {
    const b = this.findBracket(netWorth, DAILY_MAINTENANCE_BRACKETS);
    return `${(b.rate * 100).toFixed(2)}% (patrimônio entre R$${this.formatCurrency(b.min)} e R$${b.max === Infinity ? '∞' : this.formatCurrency(b.max)})`;
  },

  /** Get human-readable label for a wealth tax bracket */
  getWealthTaxBracketLabel(netWorth) {
    const b = this.findBracket(netWorth, WEALTH_TAX_BRACKETS);
    return `${(b.rate * 100).toFixed(2)}% (patrimônio entre R$${this.formatCurrency(b.min)} e R$${b.max === Infinity ? '∞' : this.formatCurrency(b.max)})`;
  },

  /** Format number as Brazilian currency */
  formatCurrency(value) {
    return value.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  },

  // Full export for admin API
  config: {
    buyFeeRate: this.buyFeeRate * 100,   // display as percent → 2
    sellFeeRate: this.sellFeeRate * 100, // display as percent → 3
    dailyMaintenanceBrackets: DAILY_MAINTENANCE_BRACKETS.map(b => ({ ...b })),
    wealthTaxBrackets: WEALTH_TAX_BRACKETS.map(b => ({ ...b })),
    wealthTaxCycleDays: 15,
  },
};
