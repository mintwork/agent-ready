import { dirname, posix } from 'node:path';
import type { RepoContext } from '../context.js';
import {
  architectureSection,
  commandsSection,
  generateAgentsMd,
  generateClaudeMd,
} from '../fix/agents-md.js';
import type { Check, FileChange, Finding } from '../types.js';
import { type ContextDoc, findContextDocs, isRootDoc } from './docs.js';
import { capForTemplate } from './template.js';

const NO_DOC = 'No agent context file (AGENTS.md / CLAUDE.md / .cursor/rules)';

function rootDocs(ctx: RepoContext): ContextDoc[] {
  return findContextDocs(ctx).filter((d) => isRootDoc(d.path));
}

/** Text inside inline code spans and fenced code blocks. */
export function codeText(md: string): string {
  const parts: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of md.matchAll(fence)) parts.push(m[1] ?? '');
  const withoutFences = md.replace(fence, '');
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) parts.push(m[1] ?? '');
  return parts.join('\n');
}

const RUNNERS =
  '(?:npm|pnpm|yarn|bun|npx|bunx|nub|vp|make|just|task|mise|moon|uv|uvx|poetry|pdm|hatch|tox|nox|python3?|pip|cargo|go|deno|turbo|nx|bazel|bazelisk|gradlew|gradle|mvnw|mvn|dotnet|rake|bundle|mix)';
/** Any tool invoked as `<tool> run|exec <task>` (e.g. `mise run test`, `nub exec vitest`). */
const GENERIC_RUN = '(?:\\b[\\w.-]+\\s+(?:run|exec)\\b)';

const COMMAND_KINDS: Record<string, RegExp> = {
  test: new RegExp(
    `(?:(?:\\b${RUNNERS}\\b|${GENERIC_RUN})[^\\n]*\\b(?:test|tests|vitest|jest|pytest|mocha|ava|nextest)\\b)|^\\s*(?:pytest|vitest|jest|mocha)\\b|(?:^|\\s)\\.\\/[\\w.-]*tests?[\\w.-]*\\b`,
    'im',
  ),
  lint: new RegExp(
    `(?:(?:\\b${RUNNERS}\\b|${GENERIC_RUN})[^\\n]*\\b(?:lint|eslint|biome|oxlint|ruff|flake8|pylint|check|typecheck|tsc|mypy|pyright|clippy|vet|golangci-lint|staticcheck)\\b)|^\\s*(?:ruff|eslint|biome|oxlint|flake8|pylint|mypy|pyright|tsc|golangci-lint|staticcheck|pre-commit)\\b`,
    'im',
  ),
  build: new RegExp(
    `(?:(?:\\b${RUNNERS}\\b|${GENERIC_RUN})[^\\n]*\\b(?:build|compile|bundle|install|sync|dev|start|package|assemble)\\b)|^\\s*(?:tsc|vite|webpack|esbuild)\\b|^\\s*(?:make|just)\\s*$`,
    'im',
  ),
};

export function detectCommands(md: string): Set<string> {
  const code = codeText(md);
  const found = new Set<string>();
  for (const [kind, re] of Object.entries(COMMAND_KINDS)) {
    if (re.test(code)) found.add(kind);
  }
  return found;
}

const NOT_PATHS = new Set(['n/a', 'i/o', 'and/or', 'true/false', 'yes/no', 'w/', 'w/o']);
const GENERATED_PREFIXES = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '.next',
  'target',
  'tmp',
  '.git',
];
const KNOWN_EXT =
  /\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|toml|md|mdx|py|pyi|sh|css|scss|html|sql|txt|cfg|ini|lock|env\.example|mdc)$/i;

/** Extract things that look like repo-relative paths from a markdown doc. */
export function extractPathRefs(md: string): string[] {
  const candidates = new Set<string>();
  const code = md.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const m of code.matchAll(/`([^`\n]+)`/g)) candidates.add((m[1] ?? '').trim());
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) candidates.add((m[1] ?? '').trim());
  // Claude Code @imports at the start of a line or after whitespace.
  for (const m of md.matchAll(/(?:^|\s)@([\w./-]+\.[\w]+)/gm)) candidates.add((m[1] ?? '').trim());

  const refs: string[] = [];
  for (let c of candidates) {
    c = c
      .replace(/^\.\//, '')
      .replace(/[#?].*$/, '')
      .replace(/[),.:;]+$/, '');
    if (!c || c.length > 200) continue;
    if (/^[a-z]+:\/\//i.test(c) || c.startsWith('mailto:') || c.startsWith('#')) continue;
    if (/[\s*<>{}$|"'`=\\[\]]/.test(c)) continue;
    if (c.startsWith('-') || c.startsWith('~') || c.startsWith('/') || c.startsWith('@')) continue;
    if (NOT_PATHS.has(c.toLowerCase())) continue;
    if (/^\d/.test(c)) continue;
    // A bare extension (`.ts`, `.md`); real dotfiles like `.nvmrc` are kept.
    if (/^\.\w+$/.test(c) && KNOWN_EXT.test(c)) continue;
    // Go module paths, registries and hosts: `github.com/org/repo`, `ghcr.io/x`.
    if (/^[\w-]+(\.[\w-]+)*\.(com|org|io|dev|net|sh|app|co|ai|so)\//i.test(c)) continue;
    const looksLikePath =
      (c.includes('/') && /^[\w.-]+(\/[\w.@-]*)+$/.test(c)) ||
      (KNOWN_EXT.test(c) && /^[\w.-]+$/.test(c));
    if (!looksLikePath) continue;
    const first = c.split('/')[0] ?? '';
    if (GENERATED_PREFIXES.includes(first)) continue;
    refs.push(c);
  }
  return refs;
}

export function extractScriptRefs(md: string): string[] {
  const code = codeText(md);
  const refs = new Set<string>();
  for (const m of code.matchAll(/\b(?:npm|pnpm|yarn|bun)[ \t]+run[ \t]+([\w:.-]+)/g))
    refs.add(m[1] ?? '');
  // pnpm/yarn shorthand: `pnpm build` (skip builtins)
  const builtins = new Set([
    'install',
    'i',
    'add',
    'remove',
    'rm',
    'up',
    'update',
    'upgrade',
    'dlx',
    'exec',
    'create',
    'init',
    'publish',
    'link',
    'unlink',
    'why',
    'outdated',
    'list',
    'ls',
    'audit',
    'run',
    'test',
    'start',
    'x',
    'global',
    'config',
    'set',
    'version',
    'info',
    'pack',
    'login',
    'logout',
    'cache',
    'workspace',
    'workspaces',
    'import',
    'patch',
    'store',
    'env',
    'prune',
    'rebuild',
    'dedupe',
    'help',
    'ci',
    'node',
    'npx',
    'tsc',
    'vitest',
    'jest',
    'eslint',
  ]);
  for (const m of code.matchAll(/^\s*(?:\$[ \t]*)?(?:pnpm|yarn)[ \t]+([\w:.-]+)/gm)) {
    const s = m[1] ?? '';
    if (!builtins.has(s) && !s.startsWith('-')) refs.add(s);
  }
  return [...refs].filter(Boolean);
}

/** Build-output directory names: a doc may legitimately mention them before anything is built. */
const OUTPUT_SEGMENTS = new Set(['node_modules', 'dist', '.next', 'target', 'coverage', '.venv']);

interface PathIndex {
  /** Every directory (repo-relative). */
  dirs: Set<string>;
  /** Every segment-aligned suffix of every file and directory path: `a/b/c.ts` -> `b/c.ts`, `c.ts`. */
  suffixes: Set<string>;
}

function buildIndex(ctx: RepoContext): PathIndex {
  const dirs = new Set<string>();
  const suffixes = new Set<string>();
  const addSuffixes = (p: string) => {
    let i = -1;
    do {
      suffixes.add(p.slice(i + 1));
      i = p.indexOf('/', i + 1);
    } while (i !== -1);
  };
  for (const f of ctx.files) {
    addSuffixes(f);
    let i = f.indexOf('/');
    while (i !== -1) {
      const d = f.slice(0, i);
      if (!dirs.has(d)) {
        dirs.add(d);
        addSuffixes(d);
      }
      i = f.indexOf('/', i + 1);
    }
  }
  return { dirs, suffixes };
}

/** `ok`/`skip`, or a missing ref whose `candidates` still need a (batched) .gitignore check. */
type PreStatus = 'ok' | 'skip' | { candidates: string[] };

function preStatus(
  ctx: RepoContext,
  docPath: string,
  ref: string,
  idx: () => PathIndex,
): PreStatus {
  const clean = ref.replace(/\/$/, '');
  const rel = posix.normalize(posix.join(dirname(docPath), clean));
  const inRepo = !rel.startsWith('..');
  // Monorepo docs often use package-relative paths (`src/cli/main.ts` for `packages/x/src/...`).
  if (idx().suffixes.has(clean) || (inRepo && idx().suffixes.has(rel))) return 'ok';
  if (ctx.exists(clean) || (inRepo && ctx.exists(rel))) return 'ok';
  // Paths the docs expect to be created by a build or local run.
  if (clean.split('/').some((seg) => OUTPUT_SEGMENTS.has(seg))) return 'skip';
  // Only anchored references count as stale: `a/b/c.ts` where `a/` is a real directory at the root
  // or next to the doc. Unanchored `a/b` is far more likely an import specifier (`ui-kit/button`),
  // `owner/repo` or a model id. A bare data file (`manifest.json`) is usually a runtime artifact;
  // bare source/markdown names (`gone.ts`) are still checked.
  const docDir = dirname(docPath);
  if (clean.includes('/')) {
    const first = clean.split('/')[0] ?? '';
    const anchored =
      idx().dirs.has(first) || (docDir !== '.' && idx().dirs.has(posix.join(docDir, first)));
    if (!anchored) return 'skip';
  } else if (
    ref.endsWith('/') ||
    /\.(?:json|jsonl|ya?ml|toml|txt|log|lock|csv|ini|cfg)$/i.test(clean)
  ) {
    return 'skip';
  }
  return { candidates: inRepo && rel !== clean ? [clean, rel] : [clean] };
}

/** The doc an append-fix should target: AGENTS.md first, then CLAUDE.md, then any root markdown doc. */
function primaryDoc(ctx: RepoContext): ContextDoc | undefined {
  const docs = rootDocs(ctx).filter((d) => !isPointerDoc(d.content));
  return (
    docs.find((d) => d.path === 'AGENTS.md') ??
    docs.find((d) => d.path === 'CLAUDE.md' || d.path === '.claude/CLAUDE.md') ??
    docs.find((d) => d.path.endsWith('.md'))
  );
}

/** A short doc that just points at another context doc (`@AGENTS.md`, `[CLAUDE.md](CLAUDE.md)`). */
export function isPointerDoc(content: string): boolean {
  return (
    content.trim().split('\n').length < 12 &&
    /(^|\s)@[\w./-]+\.md\b|\]\((?:\.\/)?(?:AGENTS|CLAUDE)\.md\)/m.test(content)
  );
}

function appendSection(doc: ContextDoc, section: string[], description: string): FileChange {
  const sep = doc.content.endsWith('\n') ? '\n' : '\n\n';
  return {
    path: doc.path,
    before: doc.content,
    after: `${doc.content}${sep}${section.join('\n')}`,
    kind: 'append',
    description,
  };
}

function noDocResult(primary = false) {
  return primary
    ? {
        score: 0,
        summary: NO_DOC,
        suggestion: 'Run `agent-ready --fix` to generate a starter AGENTS.md + CLAUDE.md.',
      }
    : { score: 0, summary: 'needs a context file' };
}

const rawContextChecks: Check[] = [
  {
    id: 'context.exists',
    category: 'context',
    title: 'Agent context file present',
    weight: 3,
    run(ctx) {
      const docs = rootDocs(ctx);
      if (docs.length === 0) return noDocResult(true);
      return { score: 1, summary: `Found ${docs.map((d) => d.path).join(', ')}` };
    },
    fix(ctx) {
      const docs = findContextDocs(ctx).filter((d) => isRootDoc(d.path));
      const changes: FileChange[] = [];
      const hasAgents = docs.some((d) => d.path === 'AGENTS.md');
      const hasClaude = docs.some((d) => d.path === 'CLAUDE.md' || d.path === '.claude/CLAUDE.md');
      if (!hasAgents && !hasClaude) {
        changes.push({
          path: 'AGENTS.md',
          before: null,
          after: generateAgentsMd(ctx),
          kind: 'create',
          description: 'Starter AGENTS.md generated from detected scripts and structure',
        });
      }
      return changes;
    },
  },
  {
    id: 'context.commands',
    category: 'context',
    title: 'Docs list build/test/lint commands',
    weight: 3,
    run(ctx) {
      const docs = rootDocs(ctx);
      if (docs.length === 0) return noDocResult();
      const found = new Set<string>();
      for (const d of docs) for (const k of detectCommands(d.content)) found.add(k);
      const expected = ['test', 'lint', 'build'];
      const missing = expected.filter((k) => !found.has(k));
      const score = (expected.length - missing.length) / expected.length;
      return {
        score,
        summary:
          missing.length === 0
            ? 'Build, test and lint commands documented'
            : `Missing ${missing.join(', ')} command(s) in context docs`,
        suggestion: missing.length
          ? `Add a "Commands" section with exact ${missing.join('/')} commands in code blocks.`
          : undefined,
      };
    },
    fix(ctx) {
      const doc = primaryDoc(ctx);
      if (
        !doc ||
        /^#{1,4}\s*(commands|scripts|development|getting started)\b/im.test(doc.content)
      ) {
        return [];
      }
      if (detectCommands(doc.content).size === 3) return [];
      return [appendSection(doc, commandsSection(ctx), 'Append detected build/test/lint commands')];
    },
  },
  {
    id: 'context.architecture',
    category: 'context',
    title: 'Docs describe architecture/layout',
    weight: 2,
    run(ctx) {
      const docs = rootDocs(ctx);
      if (docs.length === 0) return noDocResult();
      // A `- \`src/\` — TODO: describe` placeholder doesn't describe anything.
      const all = docs
        .map((d) => d.content)
        .join('\n')
        .split('\n')
        .filter((l) => !/\bTODO\b/.test(l))
        .join('\n');
      const heading =
        /^#{1,4}\s*.*\b(architecture|structure|layout|overview|organi[sz]ation|codebase|modules|directories|how it works|design)\b/im.test(
          all,
        );
      const topDirs = new Set(
        ctx.files
          .filter((f) => f.includes('/'))
          .map((f) => f.split('/')[0] as string)
          .filter((d) => !d.startsWith('.')),
      );
      const mentioned = [...topDirs].filter((d) =>
        new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(all),
      );
      const dirCoverage =
        topDirs.size === 0 ? 1 : Math.min(1, mentioned.length / Math.min(3, topDirs.size));
      const score = (heading ? 0.6 : 0) + 0.4 * dirCoverage;
      return {
        score,
        summary: heading
          ? `Architecture section found; ${mentioned.length} top-level dir(s) described`
          : `No architecture/structure section; ${mentioned.length} top-level dir(s) mentioned`,
        suggestion:
          score < 1
            ? 'Add an "Architecture" section mapping key directories (e.g. `src/`, `tests/`) to their purpose.'
            : undefined,
      };
    },
    fix(ctx) {
      const doc = primaryDoc(ctx);
      const all = rootDocs(ctx)
        .map((d) => d.content)
        .join('\n');
      if (!doc || /^#{1,4}\s*.*\b(architecture|structure|layout)\b/im.test(all)) return [];
      return [appendSection(doc, architectureSection(ctx), 'Append an Architecture section')];
    },
  },
  {
    id: 'context.fresh',
    category: 'context',
    title: 'Docs are not stale (referenced paths/scripts exist)',
    weight: 2,
    run(ctx) {
      const docs = findContextDocs(ctx);
      if (docs.length === 0) return noDocResult();
      const findings: Finding[] = [];
      let total = 0;
      const scripts = ctx.scripts();
      let index: PathIndex | null = null;
      const idx = () => {
        index ??= buildIndex(ctx);
        return index;
      };
      // CLAUDE.md is often a symlink or copy of AGENTS.md; don't report the same stale line twice.
      const seenContent = new Set<string>();
      const pending: Array<{ doc: string; ref: string; candidates: string[] }> = [];
      for (const d of docs) {
        if (seenContent.has(d.content)) continue;
        seenContent.add(d.content);
        for (const ref of extractPathRefs(d.content)) {
          const status = preStatus(ctx, d.path, ref, idx);
          if (status === 'skip') continue;
          total++;
          if (status !== 'ok') pending.push({ doc: d.path, ref, candidates: status.candidates });
        }
        if (ctx.pkg) {
          const deps = ctx.allDeps();
          for (const s of extractScriptRefs(d.content)) {
            // `pnpm prettier` / `yarn tsc` run a dependency's binary, not a script.
            if (s in deps) continue;
            total++;
            if (!(s in scripts)) {
              findings.push({
                severity: 'warn',
                file: d.path,
                message: `references missing package.json script "${s}"`,
              });
            }
          }
        }
      }
      // Gitignored paths (local output, caches) appear after a build or run: not stale.
      const ignored = ctx.isIgnoredMany(pending.flatMap((p) => p.candidates));
      const stale: Finding[] = [];
      for (const p of pending) {
        if (p.candidates.some((c) => ignored.get(c))) {
          total--;
          continue;
        }
        stale.push({
          severity: 'warn',
          file: p.doc,
          message: `references missing path \`${p.ref}\``,
        });
      }
      findings.unshift(...stale);
      const score = Math.max(0, 1 - 0.2 * findings.length);
      return {
        score,
        summary:
          findings.length === 0
            ? `All ${total} referenced paths/scripts exist`
            : `${findings.length} stale reference(s) out of ${total}`,
        findings,
        suggestion: findings.length
          ? 'Update or remove references to files/scripts that no longer exist. Stale docs actively mislead agents.'
          : undefined,
      };
    },
  },
  {
    id: 'context.length',
    category: 'context',
    title: 'Docs are concise (fit in context)',
    weight: 1,
    run(ctx) {
      const docs = rootDocs(ctx);
      if (docs.length === 0) return noDocResult();
      const findings: Finding[] = [];
      let worst = 1;
      for (const d of docs) {
        const lines = d.content.split('\n').length;
        let s = 1;
        if (lines > 1000) s = 0.1;
        else if (lines > 600) s = 0.4;
        else if (lines > 300) s = 0.7;
        else if (d.content.trim().split('\n').length < 8 && !isPointerDoc(d.content)) s = 0.5;
        if (s < 1) {
          findings.push({
            severity: 'warn',
            file: d.path,
            message:
              s === 0.5
                ? `only ${lines} lines — too thin to be useful`
                : `${lines} lines — long docs dilute attention and burn context`,
          });
        }
        worst = Math.min(worst, s);
      }
      return {
        score: worst,
        summary:
          worst === 1
            ? 'Context docs are a healthy length'
            : 'Context doc length could be improved',
        findings,
        suggestion:
          worst < 1
            ? 'Aim for 30–300 lines. Move deep detail into linked docs (e.g. `docs/`).'
            : undefined,
      };
    },
  },
  {
    id: 'context.coverage',
    category: 'context',
    title: 'Works across agents (AGENTS.md + CLAUDE.md)',
    weight: 1,
    run(ctx) {
      const docs = rootDocs(ctx);
      if (docs.length === 0) return noDocResult();
      const agents = docs.find((d) => d.path === 'AGENTS.md');
      const claude = docs.find((d) => d.path === 'CLAUDE.md' || d.path === '.claude/CLAUDE.md');
      if (agents && claude) return { score: 1, summary: 'AGENTS.md and CLAUDE.md both present' };
      const missing = agents
        ? 'CLAUDE.md (Claude Code)'
        : 'AGENTS.md (Codex, Cursor, Copilot, ...)';
      return {
        score: agents || claude ? 0.6 : 0.4,
        summary: `Missing ${missing}`,
        suggestion: agents
          ? 'Add a CLAUDE.md containing `@AGENTS.md` so Claude Code loads the same instructions.'
          : claude
            ? 'Add an AGENTS.md (read by Codex, Cursor, Copilot, Gemini and others) — `agent-ready --fix` can create one that points at CLAUDE.md.'
            : 'Add AGENTS.md and a CLAUDE.md that imports it.',
      };
    },
    fix(ctx) {
      const docs = rootDocs(ctx);
      const hasAgents = docs.some((d) => d.path === 'AGENTS.md');
      const hasClaude = docs.some((d) => d.path === 'CLAUDE.md' || d.path === '.claude/CLAUDE.md');
      const changes: FileChange[] = [];
      if (!hasClaude) {
        changes.push({
          path: 'CLAUDE.md',
          before: null,
          after: generateClaudeMd(),
          kind: 'create',
          description: 'CLAUDE.md that imports AGENTS.md for Claude Code',
        });
      }
      if (hasClaude && !hasAgents) {
        changes.push({
          path: 'AGENTS.md',
          before: null,
          after:
            '# AGENTS.md\n\nAgent instructions for this repository live in [CLAUDE.md](CLAUDE.md). Read it before making changes.\n',
          kind: 'create',
          description: 'AGENTS.md pointing at the existing CLAUDE.md',
        });
      }
      return changes;
    },
  },
];

/** Content-quality checks that an unedited generated doc can only partly satisfy. */
const TEMPLATE_CAPPED = new Set([
  'context.exists',
  'context.commands',
  'context.architecture',
  'context.fresh',
  'context.length',
]);

export const contextChecks: Check[] = rawContextChecks.map((c) =>
  TEMPLATE_CAPPED.has(c.id)
    ? {
        ...c,
        run: async (ctx, opts) =>
          capForTemplate(ctx, await c.run(ctx, opts), c.id === 'context.exists'),
      }
    : c,
);
