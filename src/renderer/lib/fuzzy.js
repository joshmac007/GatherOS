// Tiny fuzzy matcher for short strings (tag names, bucket names, etc.).
// Returns null when nothing matches; otherwise an object with `score`
// where lower = better, so callers can sort ascending.
//
// Match tiers, in order of preference:
//   exact      score 0
//   prefix     score 0.1
//   substring  score 0.3 + offset penalty   (later in word = worse)
//   subsequence score 1 + gap penalty       (chars in order with skips)
//
// Tags top out around 20 chars and libraries plateau in the low
// thousands, so this is fast enough to call inside a useMemo on
// every keystroke without precomputing anything.
export function fuzzyMatch(needle, haystack) {
  if (!needle || !haystack) return null;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  if (n === h) return { score: 0, kind: 'exact' };
  if (h.startsWith(n)) return { score: 0.1, kind: 'prefix' };

  const idx = h.indexOf(n);
  if (idx !== -1) {
    return { score: 0.3 + idx * 0.01, kind: 'substring' };
  }

  // Subsequence walk: every char of needle must appear in haystack
  // in order. Gaps add to the score so close-but-not-perfect matches
  // rank below the cleaner ones.
  let i = 0;
  let j = 0;
  let gaps = 0;
  while (i < n.length && j < h.length) {
    if (n[i] === h[j]) { i += 1; j += 1; }
    else { j += 1; gaps += 1; }
  }
  if (i === n.length) {
    return { score: 1 + gaps * 0.05, kind: 'subseq' };
  }
  return null;
}
