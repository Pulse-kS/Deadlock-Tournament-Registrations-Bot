/**
 * Fuzzy team-name matching, ported from the tournament management bot's
 * Code.gs (draft/sheet team-name reconciliation) - same algorithm, same
 * thresholds. Combines three independent similarity checks so both
 * typo-style and shorthand-style variations score well:
 *  - edit-distance/containment ("Weird & Spectacular" vs "weird and
 *    spectacular", "archers" vs "archer's")
 *  - acronym/initialism ("DG" for "Dooms Goons")
 *  - whole-word contiguous excerpt ("Dooms" for "Dooms Goons")
 */

// A fuzzy pairing needs to score at least this well to count as a match
// at all - below this, two names are treated as genuinely different
// teams, not a naming variation.
const FUZZY_MATCH_MIN_CONFIDENCE = 0.6;
// ...and the best-scoring candidate needs to beat the second-best by at
// least this much. Without a margin, two similarly-named teams both
// scoring "plausible" would get resolved by whichever happened to score
// a hair higher - basically a coin flip. Requiring a clear winner means
// a genuinely ambiguous case correctly falls through to manual handling.
const FUZZY_MATCH_MIN_MARGIN = 0.15;

function normalizeTeamName(s) {
  return String(s || '').trim().toLowerCase();
}

/** Iterative Levenshtein (edit) distance between two strings. */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let jj = 1; jj <= n; jj++) {
      const cost = a.charAt(i - 1) === b.charAt(jj - 1) ? 0 : 1;
      curr[jj] = Math.min(
        prev[jj] + 1, // deletion
        curr[jj - 1] + 1, // insertion
        prev[jj - 1] + cost // substitution
      );
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

/**
 * How similar two (already-normalized) team names are, from 0 to 1.
 * Max of edit-distance similarity and containment similarity (one name
 * fully embedded in the other, e.g. "ravens" vs "the ravens").
 */
function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const maxLen = Math.max(a.length, b.length);
  const editSimilarity = 1 - levenshteinDistance(a, b) / maxLen;

  let containmentSimilarity = 0;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) {
    containmentSimilarity = Math.min(a.length, b.length) / maxLen;
  }

  return Math.max(editSimilarity, containmentSimilarity);
}

// Words that stand for a connector when building an acronym - "&"/"and"/
// "n" are just different spellings of the same connector.
const ACRONYM_CONNECTOR_WORDS = { and: true, n: true };

/**
 * Splits a raw (case-preserved) team name into lowercase words. Always
 * splits on whitespace/punctuation and "&". splitCase/splitDigits
 * additionally split camelCase and letter/digit transitions - only
 * meaningful on the ORIGINAL casing, before normalizeTeamName lowercases
 * everything away.
 */
function splitWordsRaw(name, splitCase, splitDigits) {
  let s = String(name || '').replace(/&/g, ' and ').replace(/'/g, '');
  if (splitCase) {
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  }
  if (splitDigits) {
    s = s.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  }
  const words = s.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  return words.map((w) => w.toLowerCase());
}

/**
 * A single token can plausibly be one unit OR a compound - tries both
 * ("split": break on camelCase/digit transitions; "whole": don't) and
 * lets callers keep whichever scores better.
 */
function splitWordsVariants(name) {
  const split = splitWordsRaw(name, true, true);
  const whole = splitWordsRaw(name, false, false);
  if (split.join(' ') === whole.join(' ')) return [split];
  return [split, whole];
}

/**
 * Builds an acronym from a name's words - connector words become "n".
 * Returns both variants (connector gets its own letter, or is dropped)
 * since there's no single universal convention.
 */
function buildAcronymVariants(words) {
  const withConnectors = [];
  const withoutConnectors = [];
  words.forEach((w) => {
    if (ACRONYM_CONNECTOR_WORDS[w]) {
      withConnectors.push('n');
    } else {
      withConnectors.push(w.charAt(0));
      withoutConnectors.push(w.charAt(0));
    }
  });
  return { withConnectors: withConnectors.join(''), withoutConnectors: withoutConnectors.join('') };
}

function normalizeAcronymCandidate(s) {
  return String(s || '').toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9]/g, '');
}

/** True if every char of needle appears in haystack in the same left-to-right order (not necessarily contiguous). */
function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack.charAt(j) === needle.charAt(i)) i++;
  }
  return i === needle.length;
}

/** Checks whether candidateRaw looks like an acronym/initialism of fullNameRaw. */
function acronymMatchOneDirection(fullNameRaw, candidateRaw) {
  const candidate = normalizeAcronymCandidate(candidateRaw);
  if (candidate.length < 2) return 0; // too short to mean anything on its own

  let best = 0;
  splitWordsVariants(fullNameRaw).forEach((words) => {
    if (words.length < 2) return;
    const variants = buildAcronymVariants(words);
    [variants.withConnectors, variants.withoutConnectors].forEach((initials) => {
      if (!initials) return;
      if (candidate === initials) {
        best = Math.max(best, 1);
      } else if (candidate.length < initials.length && isSubsequence(candidate, initials)) {
        best = Math.max(best, 0.75 + 0.25 * (candidate.length / initials.length));
      }
    });
  });
  return best;
}

function acronymSimilarity(rawA, rawB) {
  return Math.max(acronymMatchOneDirection(rawA, rawB), acronymMatchOneDirection(rawB, rawA));
}

/**
 * Checks whether candidateRaw is a run of whole, exactly-spelled words
 * lifted straight out of fullNameRaw, in order, covering at least half
 * of the full name's word count.
 */
function wordSubstringMatchOneDirection(fullNameRaw, candidateRaw) {
  let best = 0;
  splitWordsVariants(fullNameRaw).forEach((fullWords) => {
    if (fullWords.length < 2) return; // nothing to take "half" of
    const minWords = Math.ceil(fullWords.length / 2);

    splitWordsVariants(candidateRaw).forEach((candWords) => {
      if (candWords.length === 0 || candWords.length > fullWords.length) return;
      if (candWords.length < minWords) return;

      for (let start = 0; start + candWords.length <= fullWords.length; start++) {
        let isMatch = true;
        for (let k = 0; k < candWords.length; k++) {
          if (fullWords[start + k] !== candWords[k]) { isMatch = false; break; }
        }
        if (isMatch) {
          best = Math.max(best, 0.7 + 0.3 * (candWords.length / fullWords.length));
          break;
        }
      }
    });
  });
  return best;
}

function wordSubstringSimilarity(rawA, rawB) {
  return Math.max(wordSubstringMatchOneDirection(rawA, rawB), wordSubstringMatchOneDirection(rawB, rawA));
}

/**
 * The overall 0-1 score: best of typo/containment, acronym/initialism,
 * and whole-word contiguous excerpt. Takes raw (case-preserved) names -
 * each sub-check does its own normalizing.
 */
function combinedSimilarity(rawA, rawB) {
  const a = normalizeTeamName(rawA);
  const b = normalizeTeamName(rawB);
  if (!a || !b) return 0;
  return Math.max(stringSimilarity(a, b), acronymSimilarity(rawA, rawB), wordSubstringSimilarity(rawA, rawB));
}

module.exports = {
  FUZZY_MATCH_MIN_CONFIDENCE,
  FUZZY_MATCH_MIN_MARGIN,
  normalizeTeamName,
  combinedSimilarity,
};
