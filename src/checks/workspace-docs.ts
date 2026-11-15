import type { RepoContext } from '../context.js';
import type { Check, CheckResult, Finding } from '../types.js';
import {
  detectWorkspaces,
  MIN_PACKAGE_CODE_FILES,
  packageCodeFiles,
  type WorkspacePackage,
  type Workspaces,
} from '../workspaces.js';
import { findContextDocs, isRootDoc } from './docs.js';

export interface PackageDocs {
  /** Context docs inside the package directory (AGENTS.md, CLAUDE.md), repo-relative. */
  nested: string[];
  /** True if the repo-level context docs mention the package by path or name. */
  mentioned: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** How an agent working inside `pkg` learns about it: its own docs, or the root docs naming it. */
export function packageDocs(ctx: RepoContext, pkg: WorkspacePackage): PackageDocs {
  const docs = findContextDocs(ctx);
  if (pkg.dir === '.') {
    return { nested: docs.filter((d) => isRootDoc(d.path)).map((d) => d.path), mentioned: true };
  }
  const nested = docs
    .filter((d) => d.path.startsWith(`${pkg.dir}/`) && /(^|\/)(AGENTS|CLAUDE)\.md$/.test(d.path))
    .map((d) => d.path)
    .filter((p) => !p.slice(pkg.dir.length + 1).includes('/') || p.endsWith('/.claude/CLAUDE.md'));
  const rootText = docs
    .filter((d) => isRootDoc(d.path))
    .map((d) => d.content)
    .join('\n');
  const parts = pkg.dir.split('/');
  const base = parts[parts.length - 1] as string;
  const container = parts.slice(0, -1).join('/');
  const mentioned =
    new RegExp(`(^|[^\\w/.-])${escapeRe(pkg.dir)}(?![\\w-])`).test(rootText) ||
    // Names only count in code (`@acme/ui`, `cargo test -p grep-cli`): plain words like "core" are prose.
    (pkg.name !== null &&
      new RegExp(`\`[^\`\n]*(?<![\\w@/.-])${escapeRe(pkg.name)}(?![\\w/-])[^\`\n]*\``).test(
        rootText,
      )) ||
    // `packages/` described with its children listed: "- `packages/` — `core`, `cli`"
    (container !== '' &&
      rootText.includes(`${container}/`) &&
      new RegExp(`\`${escapeRe(base)}/?\``).test(rootText));
  return { nested, mentioned };
}

/** Packages big enough that an agent needs to be told about them (the root package never counts). */
export function substantialPackages(
  ctx: RepoContext,
  ws: Workspaces,
): Array<{ pkg: WorkspacePackage; codeFiles: number }> {
  return ws.packages
    .filter((p) => p.dir !== '.')
    .map((pkg) => ({ pkg, codeFiles: packageCodeFiles(ctx, ws, pkg) }))
    .filter((p) => p.codeFiles >= MIN_PACKAGE_CODE_FILES);
}

export const workspaceDocsCheck: Check = {
  id: 'context.packages',
  category: 'context',
  title: 'Workspace packages are documented for agents',
  weight: 1,
  run(ctx): CheckResult {
    const ws = detectWorkspaces(ctx);
    if (!ws) return { score: null, summary: 'Not a monorepo' };
    const big = substantialPackages(ctx, ws);
    if (big.length === 0) {
      return {
        score: null,
        summary: `${ws.packages.length} workspace package(s), all under ${MIN_PACKAGE_CODE_FILES} code files`,
      };
    }
    if (!findContextDocs(ctx).some((d) => isRootDoc(d.path))) {
      return { score: 0, summary: 'needs a context file' };
    }
    const findings: Finding[] = [];
    let nestedCount = 0;
    let covered = 0;
    for (const { pkg, codeFiles } of big) {
      const d = packageDocs(ctx, pkg);
      if (d.nested.length) nestedCount++;
      if (d.nested.length || d.mentioned) covered++;
      else {
        findings.push({
          severity: 'warn',
          file: `${pkg.dir}/`,
          message: `${pkg.name ?? pkg.dir} (${codeFiles} code files) has no AGENTS.md and isn't mentioned in the root docs`,
        });
      }
    }
    const score = covered / big.length;
    return {
      score,
      summary: `${covered} of ${big.length} packages documented (${nestedCount} with their own AGENTS.md/CLAUDE.md)`,
      findings: findings.slice(0, 20),
      suggestion:
        score < 1
          ? 'List each package and what it owns in AGENTS.md, or add a nested AGENTS.md (plus a CLAUDE.md that imports it) to large packages with their own commands and conventions.'
          : undefined,
    };
  },
};
