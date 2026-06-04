const COUNTRY_NAMES = [
  'Brasil', 'Estados Unidos', 'Itália', 'Japão', 'Alemanha',
  'França', 'Argentina', 'Portugal', 'Outro',
];

function normalizeCountry(raw) {
  if (!raw) return 'Brasil';
  let s = String(raw).trim();
  s = s.replace(/^(\?{1,2}|\uFFFD)+\s*/g, '').trim();
  s = s.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '').trim();
  s = s.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+\s*/u, '').trim();
  if (!s) return 'Brasil';
  const exact = COUNTRY_NAMES.find(n => n.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const partial = COUNTRY_NAMES.find(n => s.toLowerCase().includes(n.toLowerCase()));
  return partial || s;
}

module.exports = { normalizeCountry };
