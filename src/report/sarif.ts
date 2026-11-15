import type { CheckOutcome, Finding, Report, Severity } from '../types.js';
import { BADGE_LINK } from './badge.js';

/**
 * SARIF 2.1.0 output for GitHub code scanning (and any other SARIF viewer).
 *
 * Every check is a rule. Each finding of a check that is not fully passing becomes a result; a
 * failing check without findings becomes one repo-level result anchored at `fallbackFile`.
 * `info` findings (test dummies, notes) never affect the score, so they are not reported.
 */

export interface SarifOptions {
  /**
   * Path from the SARIF consumer's root (usually the git repository root) to the scanned
   * directory, e.g. `packages/web/`. Prefixed to every file location. Default: none.
   */
  uriPrefix?: string;
  /** Repo-relative file to anchor results that have no file of their own (e.g. `README.md`). */
  fallbackFile?: string;
}

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const HELP_URI = `${BADGE_LINK}#what-it-checks`;

/** Summary of context checks that can't run without a context doc (see `noDocResult`). */
const BLOCKED = 'needs a context file';

type SarifLevel = 'error' | 'warning' | 'note';

function level(sev: Severity): SarifLevel {
  return sev === 'error' ? 'error' : sev === 'warn' ? 'warning' : 'note';
}

/** Level for a repo-level result: how far the check is from passing. */
function checkLevel(o: CheckOutcome): SarifLevel {
  return (o.score ?? 1) < 0.5 ? 'error' : 'warning';
}

/** GitHub ranks security alerts by `security-severity` (0-10); only safety checks carry one. */
function securitySeverity(o: CheckOutcome): string | undefined {
  if (o.category !== 'safety') return undefined;
  return o.id === 'safety.secrets' ? '8.0' : '5.0';
}

function uri(prefix: string, file: string): string {
  const p = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  return `${p}${file}`
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function location(prefix: string, file: string, line?: number) {
  return {
    physicalLocation: {
      artifactLocation: { uri: uri(prefix, file), uriBaseId: '%SRCROOT%' },
      ...(line ? { region: { startLine: line } } : {}),
    },
  };
}

function resultMessage(o: CheckOutcome, f?: Finding): string {
  const head = f ? `${o.title}: ${f.message}` : `${o.title}: ${o.summary}`;
  return o.suggestion ? `${head}\n${o.suggestion}` : head;
}

export function toSarif(report: Report, opts: SarifOptions = {}): object {
  const prefix = opts.uriPrefix ?? '';
  const rules = report.checks.map((o) => {
    const sev = securitySeverity(o);
    return {
      id: o.id,
      name: o.id
        .split(/[.-]/)
        .map((s) => (s[0] ?? '').toUpperCase() + s.slice(1))
        .join(''),
      shortDescription: { text: o.title },
      fullDescription: { text: `${o.title} (agent-ready ${o.category} check)` },
      helpUri: HELP_URI,
      defaultConfiguration: { level: 'warning' },
      properties: {
        category: o.category,
        tags: ['agent-ready', o.category, ...(sev ? ['security'] : [])],
        ...(sev ? { 'security-severity': sev } : {}),
      },
    };
  });
  const ruleIndex = new Map(report.checks.map((o, i) => [o.id, i]));

  const results: object[] = [];
  for (const o of report.checks) {
    if (o.score === null || o.score >= 0.999) continue;
    // Checks that only fail because there is no context file at all: one alert (context.exists) is enough.
    if (o.summary === BLOCKED) continue;
    const base = { ruleId: o.id, ruleIndex: ruleIndex.get(o.id) };
    const findings = (o.findings ?? []).filter((f) => f.severity !== 'info');
    const withFile = findings.filter((f) => f.file);
    for (const f of withFile) {
      results.push({
        ...base,
        level: level(f.severity),
        message: { text: resultMessage(o, f) },
        locations: [location(prefix, f.file as string, f.line)],
      });
    }
    // Repo-level problems (no file, or a check that fails without per-file findings).
    if (withFile.length === 0 || withFile.length < findings.length) {
      const fileless = findings.filter((f) => !f.file);
      const text =
        fileless.length > 0
          ? `${o.title}: ${o.summary}\n${fileless.map((f) => `- ${f.message}`).join('\n')}${o.suggestion ? `\n${o.suggestion}` : ''}`
          : resultMessage(o);
      results.push({
        ...base,
        level: fileless.some((f) => f.severity === 'error') ? 'error' : checkLevel(o),
        message: { text },
        ...(opts.fallbackFile ? { locations: [location(prefix, opts.fallbackFile)] } : {}),
      });
    }
  }

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: report.tool.name,
            version: report.tool.version,
            semanticVersion: report.tool.version,
            informationUri: BADGE_LINK,
            rules,
          },
        },
        automationDetails: { id: 'agent-ready/' },
        results,
        properties: { score: report.score, grade: report.grade },
      },
    ],
  };
}
