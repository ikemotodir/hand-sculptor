// Minimal i18n: ja (default) / en. Modules register their own strings with addStrings().
// Keep every string SHORT (owner rule: people don't read long text).
const DICT = { ja: {}, en: {} };
let lang = 'ja';

export function addStrings(table) {
  for (const l of Object.keys(table)) Object.assign(DICT[l] || (DICT[l] = {}), table[l]);
}

export function setLang(l) { if (DICT[l]) lang = l; document?.documentElement?.setAttribute?.('lang', lang); }
export function getLang() { return lang; }
export function detectLang() {
  const n = (typeof navigator !== 'undefined' && (navigator.language || '')) || '';
  return n.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** t('key', {n: 3}) → string with {n} replaced. Falls back to ja, then the key. */
export function t(key, vars) {
  let s = DICT[lang]?.[key] ?? DICT.ja[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, String(vars[k]));
  return s;
}
