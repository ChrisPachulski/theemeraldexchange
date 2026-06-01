/**
 * Title-normalization helpers shared across library tabs (TV, Movies).
 *
 * Kept here (not inlined per tab) so the alphabetical-sort behavior is
 * defined once and unit-tested once — both tabs must bucket/sort titles
 * identically (e.g. "The Matrix" sorts under M, not T).
 */

/**
 * Drop a single leading English article ("the", "a", "an") followed by
 * whitespace, so titles sort by their meaningful first word.
 *
 * - Case-insensitive on the article ("The"/"the"/"THE" all stripped).
 * - Only the FIRST article is removed; "The A Team" → "A Team".
 * - Requires whitespace after the article, so "Theory" and "Anvil" are
 *   left untouched (no false-positive on words that merely start with an
 *   article's letters).
 * - The original casing and remainder of the title are preserved.
 */
export const stripArticle = (s: string): string => s.replace(/^(the|a|an)\s+/i, '')
