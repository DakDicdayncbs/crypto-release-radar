import { stripVTControlCharacters } from 'node:util';

export function redact(text, secret = '') {
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

export function redactValues(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return redact(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValues(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item, secret)]));
  return value;
}

export function cleanText(value, maxLength = 200) {
  return [...stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/\s+/g, ' ').trim()].slice(0, maxLength).join('');
}

export const DIGEST_NOTICE = 'Automatic excerpt of release notes; not a verified breaking-change or security assessment. Read the source.';

export function digest(body) {
  if (!body) return { text: 'No release notes provided.', truncated: false };
  // Plain excerpt only: no inferred risk categories, no execution or Markdown rendering.
  const inputLimited = body.length > 16000;
  const text = cleanText(body.slice(0, 16000)
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/!?\[([^\[\]\n]*)\]\([^()\n]*\)/g, '$1')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/g, '$1')
    .replace(/[`*_]/g, ''), 100000);
  if (!text) return { text: 'No plain-text release notes available.', truncated: inputLimited };
  const truncated = inputLimited || [...text].length > 280;
  return { text: truncated ? [...text].slice(0, 279).join('') + '…' : text, truncated };
}
