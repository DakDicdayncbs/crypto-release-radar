import { readFile } from 'node:fs/promises';
import { readConfig, validateConfig, validateGroupSelection, selectRepositoryGroups, MAX_GROUPS } from './config.js';
import { RadarError, safeError } from './errors.js';
import { formatIssues, formatReport } from './output.js';
import { collectReport } from './radar.js';
import { parseSince, parseUntil, validateWindowOrder } from './publication-window.js';
import { compileTagPatterns, MAX_TAG_PATTERNS } from './tag-patterns.js';
import { redact, redactValues } from './text.js';

export const HELP = `Crypto Release Radar 0.1.0 — Node.js 22+

Usage: node bin/crypto-release-radar.js --config examples/repos.json [options]
       node bin/crypto-release-radar.js --demo [options]
       node bin/crypto-release-radar.js --validate-config [--config PATH]

Options:
  --config PATH             JSON config (default: radar.config.json)
  --format table|json       Output format (default: table)
  --include-prereleases     Include prereleases in every repository (no drafts)
  --limit NUMBER            Override every repository's display limit (1–50)
  --since TIMESTAMP         Include published_at >= TIMESTAMP (inclusive)
  --until TIMESTAMP         Include published_at <= TIMESTAMP (inclusive)
  --tag-pattern GLOB        Match original tags; repeat up to 10 times (OR)
  --group NAME              Select a local group; repeat for up to 10 distinct groups
  --demo                    Bundled synthetic data, no network or token access
  --validate-config         Check the entire local config without network/token access
  --help                    Show help
  --version                 Show version

Config repositories accept slug strings or objects with slug, limit and
includePrereleases. Precedence per field: CLI > repository object > top-level
config > defaults (limit 5, includePrereleases false). Explicit false is preserved.
All config fields are validated even when overridden. Reports show each policy.

Config groups map names to 1–20 explicit repository entries; at most 10 groups.
Names: 1–32 lowercase ASCII letters/digits/hyphens, starting with a letter.
Without --group use repositories. With groups, replace that list in CLI group order
and definition entry order; overlaps and totals above 20 repositories are errors.
All groups are validated, including unused ones. --group cannot combine with --demo.

--validate-config accepts only --config (default: radar.config.json), --help and
--version. It rejects scan/demo/group/format/override/filter options. Help/version
show information without validating a file. Validation never writes files and
checks no repository existence, access or authentication. Success: fixed text,
exit 0; failure: safe stderr only, exit 2. No config values or paths are printed.
Editor schema: schemas/config.schema.json (Draft 2020-12); associate externally,
do not add $schema to config. Runtime also enforces case-insensitive slug uniqueness.

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
    if (seen.has(arg) && !['--tag-pattern', '--group'].includes(arg)) throw new RadarError('usage', 'Duplicate options are not allowed. See --help.');
    seen.add(arg);
    switch (arg) {
      case '--help': options.help = true; break;
      case '--version': options.version = true; break;
      case '--demo': options.demo = true; break;
      case '--validate-config': options.validateConfig = true; break;
      case '--include-prereleases': options.includePrereleases = true; break;
      case '--group': {
        const value = args[++i];
        if (value === undefined || value.startsWith('--')) throw new RadarError('usage', 'An option value is missing. See --help.');
        options.groups ??= [];
        if (options.groups.length >= MAX_GROUPS) throw new RadarError('usage', 'Select at most 10 groups. See --help.');
        options.groups.push(value);
        break;
      }
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
  if (options.validateConfig && [...seen].some(arg => !['--validate-config', '--config', '--help', '--version'].includes(arg))) {
    throw new RadarError('usage', '--validate-config accepts only --config, --help and --version.');
  }
  if (!['table', 'json'].includes(options.format)) throw new RadarError('usage', '--format must be table or json.');
  if (options.demo && seen.has('--config')) throw new RadarError('usage', '--demo uses bundled repositories and cannot be combined with --config.');
  validateGroupSelection(options.groups);
  if (options.demo && options.groups?.length) throw new RadarError('usage', '--group cannot be combined with --demo.');
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
    if (options.validateConfig) {
      await readConfig(options.configPath);
      stdout.write('Config is valid locally. Repository existence, access and authentication were not checked.\n');
      return 0;
    }
    let config, demoData;
    if (options.demo) {
      try { demoData = JSON.parse(await readFile(new URL('../fixtures/demo-releases.json', import.meta.url), 'utf8')); }
      catch { throw new RadarError('demo_read', 'Cannot read bundled synthetic demo data.'); }
      config = validateConfig({ repositories: Object.keys(demoData) });
    } else {
      config = await readConfig(options.configPath);
      selectRepositoryGroups(config, options.groups); // Resolve errors before token access.
      const suppliedToken = env.GITHUB_TOKEN;
      if (suppliedToken !== undefined && typeof suppliedToken !== 'string') throw new RadarError('invalid_token', 'GITHUB_TOKEN must be a string.');
      token = suppliedToken ?? '';
      if (token && (!/^[\x21-\x7e]+$/.test(token) || token.length > 4096)) throw new RadarError('invalid_token', 'GITHUB_TOKEN contains invalid characters or exceeds the size limit.');
    }
    const report = await collectReport(config, {
      token, fetchImpl, demoData, now, since: options.since, until: options.until, tagPatterns: options.tagPatterns,
      groups: options.groups,
      policyOverrides: { limit: options.limit, includePrereleases: options.includePrereleases },
    });
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
