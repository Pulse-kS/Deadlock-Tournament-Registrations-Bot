const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FUZZY_MATCH_MIN_CONFIDENCE,
  normalizeTeamName,
  combinedSimilarity,
} = require('../src/utils/teamNameMatch');

test('normalizeTeamName trims and lowercases', () => {
  assert.equal(normalizeTeamName('  Weird & Spectacular  '), 'weird & spectacular');
  assert.equal(normalizeTeamName(''), '');
  assert.equal(normalizeTeamName(null), '');
});

test('combinedSimilarity: identical names score 1', () => {
  assert.equal(combinedSimilarity('Dooms Goons', 'Dooms Goons'), 1);
});

test('combinedSimilarity: "&" vs "and" typo/containment variation matches confidently', () => {
  const score = combinedSimilarity('Weird & Spectacular', 'weird and spectacular');
  assert.ok(score >= FUZZY_MATCH_MIN_CONFIDENCE, `expected >= ${FUZZY_MATCH_MIN_CONFIDENCE}, got ${score}`);
});

test('combinedSimilarity: apostrophe variation matches confidently', () => {
  const score = combinedSimilarity('Archers', "Archer's");
  assert.ok(score >= FUZZY_MATCH_MIN_CONFIDENCE, `expected >= ${FUZZY_MATCH_MIN_CONFIDENCE}, got ${score}`);
});

test('combinedSimilarity: acronym/initialism matches confidently', () => {
  const score = combinedSimilarity('DG', 'Dooms Goons');
  assert.ok(score >= FUZZY_MATCH_MIN_CONFIDENCE, `expected >= ${FUZZY_MATCH_MIN_CONFIDENCE}, got ${score}`);
});

test('combinedSimilarity: acronym with connector word ("&"/"and"/"n") matches either variant', () => {
  // "Terrible Gamers United" -> "TGU" (no connector) - sanity check the
  // acronym path works without a connector word involved at all.
  const score = combinedSimilarity('TGU', 'Terrible Gamers United');
  assert.ok(score >= FUZZY_MATCH_MIN_CONFIDENCE, `expected >= ${FUZZY_MATCH_MIN_CONFIDENCE}, got ${score}`);
});

test('combinedSimilarity: whole-word contiguous excerpt matches confidently', () => {
  // "Dooms" is one of two words in "Dooms Goons" - exactly half, which is
  // the documented minimum (minWords = ceil(fullWords.length / 2)).
  const score = combinedSimilarity('Dooms', 'Dooms Goons');
  assert.ok(score >= FUZZY_MATCH_MIN_CONFIDENCE, `expected >= ${FUZZY_MATCH_MIN_CONFIDENCE}, got ${score}`);
});

test('combinedSimilarity: unrelated single word does not clear the excerpt threshold against a longer name', () => {
  // Only 1 of 4 words shared - well under the "at least half" rule, so this
  // must NOT be treated as a whole-word excerpt match.
  const score = combinedSimilarity('Goons', 'Terrible Gamers United Forever');
  assert.ok(score < FUZZY_MATCH_MIN_CONFIDENCE, `expected < ${FUZZY_MATCH_MIN_CONFIDENCE}, got ${score}`);
});

test('combinedSimilarity: genuinely different team names score low', () => {
  const score = combinedSimilarity('AUSKR', 'Black King Bar');
  assert.ok(score < FUZZY_MATCH_MIN_CONFIDENCE, `expected < ${FUZZY_MATCH_MIN_CONFIDENCE}, got ${score}`);
});

test('combinedSimilarity: blank input never matches', () => {
  assert.equal(combinedSimilarity('', 'Dooms Goons'), 0);
  assert.equal(combinedSimilarity('Dooms Goons', ''), 0);
  assert.equal(combinedSimilarity('', ''), 0);
});
