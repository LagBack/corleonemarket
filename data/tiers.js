const TIER_CONFIG = {
  don_corleone: { id: 'don_corleone', name: 'Don Corleone', emoji: '🔥', threshold: 1_000_000_000 },
  supremo:      { id: 'supremo',      name: 'Supremo',     emoji: '⚡', threshold: 500_000_000 },
  magnata:      { id: 'magnata',      name: 'Magnata',     emoji: '🏆', threshold: 100_000_000 },
  padrinom:     { id: 'padrinom',     name: 'Padrino',     emoji: '🎭', threshold: 10_000_000 },
  notavel:      { id: 'notavel',      name: 'Notável',     emoji: '🏛️', threshold: 1_000_000 },
  investidor:   { id: 'investidor',   name: 'Investidor',  emoji: '💰', threshold: 0 },
};

const TIER_ORDER = ['don_corleone', 'supremo', 'magnata', 'padrinom', 'notavel', 'investidor'];

function computeTier(wealth) {
  const w = typeof wealth === 'number' ? wealth : 0;
  for (const tierId of TIER_ORDER) {
    if (w >= TIER_CONFIG[tierId].threshold) return tierId;
  }
  return 'investidor';
}

function tierLabel(tierId) {
  const t = TIER_CONFIG[tierId] || TIER_CONFIG.investidor;
  return `${t.emoji} ${t.name.toUpperCase()}`;
}

module.exports = { TIER_CONFIG, TIER_ORDER, computeTier, tierLabel };
