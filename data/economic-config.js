// ── Economic System Configuration ───────────────────────────────────────
// All rates are configurable — change via /api/economic/config API.
// Rates stored as decimals in economic-rates.json (0.02 = 2%).

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'economic-rates.json');

const FALLBACK = {
  buyFeeRate:         0.02,
  sellFeeRate:        0.03,
  dailyMaintenanceBrackets: [
    { min: 0,              max: 1_000_000,     rate: 0.0020 },
    { min: 1_000_001,     max: 5_000_000,     rate: 0.0035 },
    { min: 5_000_001,     max: 10_000_000,    rate: 0.0050 },
    { min: 10_000_001,    max: 25_000_000,    rate: 0.0075 },
    { min: 25_000_001,    max: 50_000_000,    rate: 0.0100 },
    { min: 50_000_001,    max: 100_000_000,   rate: 0.0125 },
    { min: 100_000_001,   max: Infinity,       rate: 0.0150 },
  ],
  wealthTaxBrackets: [
    { min: 0,             max: 5_000_000,   rate: 0.02 },
    { min: 5_000_001,    max: 25_000_000,  rate: 0.04 },
    { min: 25_000_001,   max: 100_000_000, rate: 0.06 },
    { min: 100_000_001,  max: Infinity,     rate: 0.08 },
  ],
  wealthTaxCycleDays: 15,
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const c = JSON.parse(raw);

    return {
      buyFeeRate:         Number(c.buyFeeRate)     || FALLBACK.buyFeeRate,
      sellFeeRate:        Number(c.sellFeeRate)     || FALLBACK.sellFeeRate,
      dailyMaintenanceBrackets: (c.dailyMaintenanceBrackets || FALLBACK.dailyMaintenanceBrackets).map(b => {
        let max = b.max === null ? Infinity : Number(b.max);
        if (max === 0 && Number(b.min) > 0) max = Infinity; // corrupted null→0 on non-first bracket → fix
        return { min: Number(b.min), max, rate: Number(b.rate) };
      }),
      wealthTaxBrackets:  (c.wealthTaxBrackets || FALLBACK.wealthTaxBrackets).map(b => {
        let max = b.max === null ? Infinity : Number(b.max);
        if (max === 0 && Number(b.min) > 0) max = Infinity; // corrupted null→0 on non-first bracket → fix
        return { min: Number(b.min), max, rate: Number(b.rate) };
      }),
      wealthTaxCycleDays: Number(c.wealthTaxCycleDays) || FALLBACK.wealthTaxCycleDays,
    };
  } catch {
    return { ...FALLBACK };
  }
}

function saveConfig(cfg) {
  // Normalize brackets: last bracket with max<=0 or corrupted values → Infinity/null
  function normBrackets(arr) {
    if (!arr || arr.length === 0) return [];
    const len = arr.length;
    return arr.map((b, i) => {
      let max = b.max;
      if (i === len - 1 && (max === Infinity || Number(max) <= 0 || isNaN(Number(max)))) {
        max = Infinity; // last bracket always Infinity
      } else if (Number(max) === 0 && Number(b.min) > 0) {
        max = Infinity; // corrupted zero → fix
      }
      return { min: Number(b.min), max: max === Infinity ? null : Number(max), rate: Number(b.rate) };
    });
  }
  const payload = {
    buyFeeRate:         Number(cfg.buyFeeRate)     || FALLBACK.buyFeeRate,
    sellFeeRate:        Number(cfg.sellFeeRate)     || FALLBACK.sellFeeRate,
    dailyMaintenanceBrackets: normBrackets(cfg.dailyMaintenanceBrackets),
    wealthTaxBrackets:  normBrackets(cfg.wealthTaxBrackets),
    wealthTaxCycleDays: Number(cfg.wealthTaxCycleDays) || FALLBACK.wealthTaxCycleDays,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function getConfig() { return loadConfig(); }

// Module body — initialize defaults if file doesn't exist
if (!fs.existsSync(CONFIG_PATH)) {
  saveConfig({ ...FALLBACK });
}

module.exports = {
  get buyFeeRate()         { return loadConfig().buyFeeRate; },
  get sellFeeRate()        { return loadConfig().sellFeeRate; },
  get dailyMaintenanceBrackets() { return loadConfig().dailyMaintenanceBrackets; },
  get wealthTaxBrackets()  { return loadConfig().wealthTaxBrackets; },
  get wealthTaxCycleDays() { return loadConfig().wealthTaxCycleDays; },

  saveConfig,
  getConfig,

  /** Find the applicable rate bracket for a given net worth */
  findBracket(netWorth, brackets) {
    for (const b of brackets) {
      if (netWorth >= b.min && netWorth <= b.max) return b;
    }
    return brackets[brackets.length - 1];
  },

  /** Calculate daily maintenance fee for a given net worth */
  calculateDailyMaintenance(netWorth) {
    const bracket = this.findBracket(netWorth, this.dailyMaintenanceBrackets);
    return Math.round(netWorth * bracket.rate * 100) / 100;
  },

  /** Calculate wealth tax for a given net worth */
  calculateWealthTax(netWorth) {
    const bracket = this.findBracket(netWorth, this.wealthTaxBrackets);
    return Math.round(netWorth * bracket.rate * 100) / 100;
  },

  /** Calculate trading fee for an order */
  calculateTradingFee(tradeValue, orderType) {
    const rate = orderType === 'buy' ? this.buyFeeRate : this.sellFeeRate;
    return Math.round(tradeValue * rate * 100) / 100;
  },

  /** Get human-readable label for a maintenance fee bracket */
  getMaintenanceBracketLabel(netWorth) {
    const b = this.findBracket(netWorth, this.dailyMaintenanceBrackets);
    return `${(b.rate * 100).toFixed(2)}% (patrimônio entre R$${this.formatCurrency(b.min)} e R$${b.max === Infinity ? '∞' : this.formatCurrency(b.max)})`;
  },

  /** Get human-readable label for a wealth tax bracket */
  getWealthTaxBracketLabel(netWorth) {
    const b = this.findBracket(netWorth, this.wealthTaxBrackets);
    return `${(b.rate * 100).toFixed(2)}% (patrimônio entre R$${this.formatCurrency(b.min)} e R$${b.max === Infinity ? '∞' : this.formatCurrency(b.max)})`;
  },

  /** Format number as Brazilian currency */
  formatCurrency(value) {
    return value.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  },
};
