import { RadarError } from './errors.js';
import { publishedDate } from './releases.js';

export function parseSince(value) {
  const utc = publishedDate(value);
  // Keep the normalized value in the same bounded format so revalidation is safe.
  if (!utc || value !== value.trim() || value.endsWith('-00:00') ||
      !/^\d{4}-/.test(utc) || Number(utc.slice(0, 4)) < 1970) {
    throw new RadarError('usage', '--since requires a valid timestamp: YYYY-MM-DDTHH:mm:ss[.sss] with Z or a known +/-HH:mm offset; 1–3 fractional digits, years 1970–9999 in both input and UTC. See --help.');
  }
  return utc;
}
