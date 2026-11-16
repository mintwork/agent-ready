import { CATEGORIES } from '../scan.js';
import type { CheckOutcome, Report, WorkspaceReport } from '../types.js';
import type { Colors } from '../util/color.js';

function bar(score: number, width: number): string {
  const filled = Math.round((score / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function scoreColor(score: number): 'green' | 'yellow' | 'red' {
  return score >= 80 ? 'green' : score >= 50 ? 'yellow' : 'red';
}

function icon(o: CheckOutcome, colors: Colors): string {
  if (o.score === null) return colors.c('gray', '-');
  if (o.score >= 0.999) return colors.c('green', '✓');
  if (o.score >= 0.5) return colors.c('yellow', '!');
  return colors.c('red', '✗');
}

export interface TerminalOptions {
  verbose: boolean;
}

const MAX_PACKAGES_SHOWN = 10;

function renderWorkspaces(ws: WorkspaceReport, colors: Colors, opts: TerminalOptions): string[] {
  const c = colors.c.bind(colors);
  const out: string[] = [''];
  const agg =
    ws.aggregate === null
      ? c('gray', 'n/a')
      : `${c(scoreColor(ws.aggregate), String(ws.aggregate))}${c('gray', '/100')}`;
  out.push(
    `  ${c('bold', 'Workspaces')}  ${c('gray', `${ws.kinds.join(' + ')} · ${ws.total} package(s) · aggregate`)} ${agg}`,
  );
  const rated = [...ws.packages].sort(
    (a, b) => (a.score ?? 101) - (b.score ?? 101) || a.dir.localeCompare(b.dir),
  );
  const shown = opts.verbose
    ? [...ws.packages]
    : rated.slice(0, MAX_PACKAGES_SHOWN).sort((a, b) => a.dir.localeCompare(b.dir));
  const width = Math.min(40, Math.max(...shown.map((p) => p.dir.length)));
  for (const p of shown) {
    const label = (p.dir.length > width ? `…${p.dir.slice(-(width - 1))}` : p.dir).padEnd(width);
    const docs = p.docs.length
      ? p.docs.map((d) => d.slice(d.lastIndexOf('/') + 1)).join(' + ')
      : p.mentioned
        ? 'in root docs'
        : c('yellow', 'no docs');
    const worst = [...p.issues].sort((a, b) => a.score - b.score)[0];
    const issue = worst ? c('gray', ` · ${worst.title.toLowerCase()}`) : '';
    if (p.score === null) {
      out.push(`    ${label} ${c('gray', `${'n/a'.padStart(3)}  ${'·'.repeat(10)}`)}  ${docs}`);
    } else {
      const col = scoreColor(p.score);
      out.push(
        `    ${label} ${c(col, String(p.score).padStart(3))}  ${c(col, bar(p.score, 10))}  ${docs}${issue}`,
      );
    }
  }
  const hidden = ws.total - shown.length;
  if (hidden > 0) {
    const why =
      ws.packages.length < ws.total
        ? `${ws.total - ws.packages.length} small package(s) not scored`
        : '--verbose for all';
    out.push(c('gray', `    …and ${hidden} more (${why})`));
  }
  return out;
}

export function renderTerminal(report: Report, colors: Colors, opts: TerminalOptions): string {
  const c = colors.c.bind(colors);
  const out: string[] = [];
  out.push('');
  out.push(
    `  ${c('bold', report.tool.name)} ${c('gray', `v${report.tool.version}`)}  ${c('gray', report.root)}`,
  );
  out.push(
    `  ${c('gray', `${report.fileCount} files · ${report.languages.join(', ') || 'unknown stack'} · ${report.durationMs}ms`)}`,
  );
  if (report.truncated) {
    out.push(
      `  ${c('yellow', `! Repo has more than ${report.fileCount} files; only the first ${report.fileCount} were scanned.`)}`,
    );
  }
  out.push('');
  const sc = scoreColor(report.score);
  out.push(
    `  ${c('bold', 'Agent-ready score')}  ${c(sc, c('bold', `${report.score}`))}${c('gray', '/100')}  ${c(sc, bar(report.score, 24))}  ${c(sc, report.grade)}`,
  );
  if (report.potentialScore > report.score) {
    out.push(
      `  ${c('yellow', `Fill in the TODO sections in ${report.templateDocs.join(', ')} to unlock the remaining +${report.potentialScore - report.score} points.`)}`,
    );
  }
  out.push('');
  for (const cat of report.categories) {
    const label = cat.title.padEnd(16);
    if (cat.score === null) {
      out.push(`  ${label} ${c('gray', `${'n/a'.padStart(3)}  ${'·'.repeat(20)}`)}`);
    } else {
      const col = scoreColor(cat.score);
      out.push(
        `  ${label} ${c(col, String(cat.score).padStart(3))}  ${c(col, bar(cat.score, 20))}  ${c('gray', `weight ${cat.weight}%`)}`,
      );
    }
  }

  if (report.workspaces) out.push(...renderWorkspaces(report.workspaces, colors, opts));

  for (const cat of CATEGORIES) {
    const checks = report.checks.filter((o) => o.category === cat.id);
    const blocked = checks.filter((o) => o.summary === 'needs a context file');
    const visible = (
      opts.verbose ? checks : checks.filter((o) => o.score !== null && o.score < 0.999)
    ).filter((o) => !blocked.includes(o));
    if (visible.length === 0 && blocked.length === 0) continue;
    out.push('');
    out.push(`  ${c('bold', cat.title)}`);
    for (const o of visible) {
      const pts = o.score === null ? '' : c('gray', ` (${Math.round(o.score * 100)}%)`);
      out.push(`   ${icon(o, colors)} ${o.title}${pts} ${c('gray', `— ${o.summary}`)}`);
      const findings = o.findings ?? [];
      const shown = opts.verbose ? findings : findings.slice(0, 5);
      for (const f of shown) {
        const loc = f.file ? `${c('cyan', `${f.file}${f.line ? `:${f.line}` : ''}`)} ` : '';
        out.push(`       ${c('gray', '·')} ${loc}${f.message}`);
      }
      if (findings.length > shown.length)
        out.push(c('gray', `       · …and ${findings.length - shown.length} more (--verbose)`));
      if (o.suggestion && o.score !== null && o.score < 0.999) {
        out.push(
          `       ${c('magenta', '→')} ${o.suggestion}${o.fixable ? c('green', '  [fixable: --fix]') : ''}`,
        );
      }
    }
    if (blocked.length) {
      out.push(
        `   ${c('red', '✗')} ${blocked.length} more check(s) ${c('gray', `(${blocked.map((b) => b.id).join(', ')}) score 0 until a context file exists`)}`,
      );
    }
  }
  out.push('');
  const fixable = report.checks.filter((o) => o.fixable).length;
  const hints: string[] = [];
  if (fixable) hints.push(`${c('green', 'agent-ready --fix')} to auto-fix ${fixable} check(s)`);
  hints.push(`${c('cyan', 'agent-ready --badge')} for a README badge`);
  if (!opts.verbose) hints.push(`${c('gray', '--verbose')} for passing checks`);
  out.push(`  ${c('gray', 'Next:')} ${hints.join(c('gray', ' · '))}`);
  out.push('');
  return out.join('\n');
}
