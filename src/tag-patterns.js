import { RadarError } from './errors.js';

export const MAX_TAG_PATTERNS = 10;
const invalid = () => { throw new RadarError('usage', '--tag-pattern accepts up to 10 nonempty globs of at most 128 Unicode code points (256 UTF-16 units). Only escapes for *, ? and backslash are allowed; control/format characters are forbidden. See --help.'); };

function parsePattern(pattern) {
  // Bound input before Unicode iteration or allocation. No user-supplied regex.
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 256 ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(pattern)) invalid();
  const points = [...pattern];
  if (points.length > 128) invalid();
  const tokens = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === '\\') {
      const literal = points[++i];
      if (!['*', '?', '\\'].includes(literal)) invalid();
      tokens.push({ kind: 'literal', value: literal });
    } else tokens.push({ kind: point === '*' || point === '?' ? point : 'literal', value: point });
  }
  return tokens;
}

function matchesPattern(tokens, tag) {
  // Dynamic programming: O(pattern tokens * tag code points) time, O(tokens)
  // memory, no recursive/exponential backtracking. Tags are validated <=1024 units.
  let previous = new Uint8Array(tokens.length + 1), next = new Uint8Array(tokens.length + 1);
  previous[0] = 1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === '*') previous[i + 1] = previous[i];
  }
  for (const point of tag) {
    next[0] = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      next[i + 1] = token.kind === '*'
        ? previous[i + 1] || next[i]
        : previous[i] && (token.kind === '?' || token.value === point);
    }
    [previous, next] = [next, previous];
  }
  return previous[tokens.length] === 1;
}

export function compileTagPatterns(patterns = []) {
  if (!Array.isArray(patterns) || patterns.length > MAX_TAG_PATTERNS) invalid();
  const compiled = Array.from(patterns, parsePattern);
  return {
    patterns: [...patterns],
    matches: (tag) => typeof tag === 'string' && tag.length <= 1024 &&
      (!compiled.length || compiled.some(tokens => matchesPattern(tokens, tag))),
  };
}
