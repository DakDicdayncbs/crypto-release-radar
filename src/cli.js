import { readFile } from 'node:fs/promises';
import { readConfig, validateConfig } from './config.js';
import { RadarError, safeError } from './errors.js';
import { formatIssues, formatReport } from './output.js';
import { collectReport } from './radar.js';
import { parseSince, parseUntil, validateWindowOrder } from './publication-window.js';
import { compileTagPatterns, MAX_TAG_PATTERNS } from './tag-patterns.js';
import { redact, redactValues } from './text.js';

export const HELP = `Crypto Release Radar 0.1.0 — Node.js 22+

Usage: node bin/crypto-release-radar.js --config examples/repos.json [options]
       node bin/crypto-release-radar.js --demo [options]

Options:
  --config PATH             JSON config (default: radar.config.json)
  --format table|json       Output format (default: table)
  --include-prereleases     Include prereleases (drafts always excluded)
  --limit NUMBER            Display 1–50 releases per repository
  --since TIMESTAMP         Include published_at >= TIMESTAMP (inclusive)
  --until TIMESTAMP         Include published_at <= TIMESTAMP (inclusive)
  --tag-pattern GLOB        Match original tags; repeat up to 10 times (OR)
  --demo                    Bundled synthetic data, no network or token access
  --help                    Show help
  --version                 Show version

--since/--until format: YYYY-MM-DDTHH:mm:ss[.sss](Z|+HH:mm|-HH:mm).
Use uppercase T/Z, seconds, and a known timezone; optional 1–3 fractional digits.
Years 1970–9999 in input and UTC; offset hours 00–23, minutes 00–59.
No whitespace, leap seconds, 24:00, or unknown offset -00:00. Output is UTC .sssZ.
Either bound can be used alone; together they include both ends of [since, until].
--since must be <= --until as an instant; equal bounds select that exact instant.
Filtering never stops pagination early or makes an incomplete scan complete.

Tag globs match the whole original tag, case-sensitively: * = zero or more Unicode
code points, ? = one. Escape only *, ? or backslash with backslash; others literal.
Max 128 code points / 256 UTF-16 units per glob; no control/format characters.
Quote globs in your shell, e.g. --tag-pattern 'v1.*'. For leading -- use
--tag-pattern='--literal*'. Patterns are public report data; never include secrets.

Optional environment: GITHUB_TOKEN (sent only to https://api.github.com).
Exit codes: 0 complete; 1 incomplete/API failure; 2 config/usage/local failure.
Digest is an automatic excerpt, not a verified breaking/security assessment.
`;

export function parseArgs(args) {
  const options = { configPath: 'radar.config.json', format: 'table', demo: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const inlinePattern = args[i].startsWith('--tag-pattern=') ? args[i].slice('--tag-pattern='.length) : undefined;
    const arg = inlinePattern === undefined ? args[i] : '--tag-pattern';
    if (seen.has(arg) && arg !== '--tag-pattern') throw new RadarError('usage', 'Duplicate options are not allowed. See --help.');
    seen.add(arg);
    switch (arg) {
      case '--help': options.help = true; break;
      case '--version': options.version = true; break;
      case '--demo': options.demo = true; break;
      case '--include-prereleases': options.includePrereleases = true; break;
      case '--tag-pattern': {
        const value = inlinePattern === undefined ? args[++i] : inlinePattern;
        if (value === undefined || (inlinePattern === undefined && value.startsWith('--'))) throw new RadarError('usage', 'An option value is missing. See --help.');
        options.tagPatterns ??= [];
        if (options.tagPatterns.length >= MAX_TAG_PATTERNS) throw new RadarError('usage', '--tag-pattern accepts at most 10 patterns. See --help.');
        options.tagPatterns.push(value);
        break;
      }
      case '--config':
      case '--format':
      case '--since':
      case '--until':
      case '--limit': {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new RadarError('usage', 'An option value is missing. See --help.');
        if (arg === '--config') options.configPath = value;
        if (arg === '--format') options.format = value;
        if (arg === '--since') options.since = parseSince(value);
        if (arg === '--until') options.until = parseUntil(value);
        if (arg === '--limit') {
          if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) throw new RadarError('usage', '--limit must be an integer between 1 and 50.');
          options.limit = Number(value);
        }
        break;
      }
      default: throw new RadarError('usage', 'Unknown option or positional argument. See --help.');
    }
  }
  if (!['table', 'json'].includes(options.format)) throw new RadarError('usage', '--format must be table or json.');
  if (options.demo && seen.has('--config')) throw new RadarError('usage', '--demo uses bundled repositories and cannot be combined with --config.');
  validateWindowOrder(options.since, options.until);
  compileTagPatterns(options.tagPatterns);
  return options;
}

export async function runCli(args, { stdout = process.stdout, stderr = process.stderr, env = process.env, fetchImpl, now } = {}) {
  let token = '';
  let format = 'table';
  try {
    const options = parseArgs(args);
    format = options.format;
    if (options.help) { stdout.write(HELP); return 0; }
    if (options.version) { stdout.write('0.1.0\n'); return 0; }
    let config, demoData;
    if (options.demo) {
      try { demoData = JSON.parse(await readFile(new URL('../fixtures/demo-releases.json', import.meta.url), 'utf8')); }
      catch { throw new RadarError('demo_read', 'Cannot read bundled synthetic demo data.'); }
      config = validateConfig({ repositories: Object.keys(demoData) });
    } else {
      config = await readConfig(options.configPath);
      const suppliedToken = env.GITHUB_TOKEN;
      if (suppliedToken !== undefined && typeof suppliedToken !== 'string') throw new RadarError('invalid_token', 'GITHUB_TOKEN must be a string.');
      token = suppliedToken ?? '';
      if (token && (!/^[\x21-\x7e]+$/.test(token) || token.length > 4096)) throw new RadarError('invalid_token', 'GITHUB_TOKEN contains invalid characters or exceeds the size limit.');
    }
    if (options.includePrereleases) config.includePrereleases = true;
    if (options.limit !== undefined) config.limit = options.limit;
    const report = await collectReport(config, { token, fetchImpl, demoData, now, since: options.since, until: options.until, tagPatterns: options.tagPatterns });
    // Redact strings before serializing JSON so token text cannot corrupt its syntax.
    stdout.write(formatReport(redactValues(report, token), format));
    stderr.write(redact(formatIssues(report.issues), token));
    return report.complete ? 0 : 1;
  } catch (error) {
    const issue = safeError(error);
    if (format === 'json') stdout.write(JSON.stringify(redactValues({ schemaVersion: 1, complete: false, releases: [], issues: [issue] }, token), null, 2) + '\n');
    stderr.write(redact(formatIssues([issue]), token));
    return 2;
  }
}
