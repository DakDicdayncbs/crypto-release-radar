import { RadarError } from './errors.js';

// Existing upper bound: 20 repositories, each selecting at most 50 releases.
export const MAX_TOTAL_LIMIT = 1000;
const invalid = () => { throw new RadarError('usage', '--total-limit must be a canonical decimal integer between 1 and 1000.'); };

export function validateTotalLimit(value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > MAX_TOTAL_LIMIT)) invalid();
  return value;
}

export function parseTotalLimit(value) {
  if (typeof value !== 'string' || value.length > 4 || !/^[1-9][0-9]*$/.test(value)) invalid();
  return validateTotalLimit(Number(value));
}
