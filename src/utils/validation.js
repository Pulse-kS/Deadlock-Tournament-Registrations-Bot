const isoCountries = require('i18n-iso-countries');
isoCountries.registerLocale(require('i18n-iso-countries/langs/en.json'));

// Abbreviations/common names the ISO package's English locale doesn't recognize.
const COUNTRY_ALIASES = {
  usa: 'United States', us: 'United States', 'united states of america': 'United States',
  uk: 'United Kingdom', england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom',
  uae: 'United Arab Emirates', 'south korea': 'Korea, Republic of', korea: 'Korea, Republic of',
  'czech republic': 'Czechia', holland: 'Netherlands',
};

// Sentinel stored in place of a country code when a player was asked and
// consciously declined to disclose their nationality - distinct from "" /
// null, which mean the field was never asked/answered at all.
const NATIONALITY_NONE = 'NONE';

/**
 * Accepts a country name, an ISO 3166-1 alpha-2 code, or "none" (to mean
 * "consciously not disclosing"); always returns the alpha-2 code (e.g. "AU")
 * or the NATIONALITY_NONE sentinel, so the data is consistent for the roster
 * export. Returns null if unrecognized.
 */
function validateNationality(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase() === 'none') return NATIONALITY_NONE;

  if (/^[A-Za-z]{2}$/.test(trimmed) && isoCountries.isValid(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }

  const alias = COUNTRY_ALIASES[trimmed.toLowerCase()];
  const code = isoCountries.getAlpha2Code(alias || trimmed, 'en');
  return code || null;
}

// Display label for a stored nationality value - swaps the raw sentinel for
// something a captain/staff reading the control panel understands.
function formatNationality(code) {
  if (code === NATIONALITY_NONE) return 'Undisclosed';
  return code || '';
}

module.exports = { validateNationality, formatNationality, NATIONALITY_NONE };
