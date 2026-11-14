import { projectTsconfigs, resolveCompilerOptions } from '../checks/type-safety.js';
import type { RepoContext } from '../context.js';
import { isFixturePath } from '../util/paths.js';

/**
 * A step-by-step plan for turning on TypeScript `strict` mode. Report only: agent-ready never edits
 * a tsconfig, because each flag can surface hundreds of errors that a human (or an agent with a
 * human reviewing) should fix one flag per PR.
 */

export interface StrictStep {
  flag: string;
  /** Already enabled in the resolved compilerOptions. */
  done: boolean;
  /** Why this step is where it is / what to expect. */
  note: string;
}

export interface StrictPlan {
  tsconfig: string;
  steps: StrictStep[];
  /** Command that previews the errors for a flag without editing the tsconfig. */
  preview: string;
}

/** The flags `strict: true` turns on, ordered from usually-painless to usually-hard. */
const FLAGS: Array<{ flag: string; note: string }> = [
  { flag: 'alwaysStrict', note: 'emits "use strict"; rarely any errors' },
  { flag: 'strictBindCallApply', note: 'checks bind/call/apply arguments; few errors' },
  { flag: 'strictFunctionTypes', note: 'contravariant callback parameters; few errors' },
  { flag: 'noImplicitThis', note: '`this` must have a known type' },
  { flag: 'useUnknownInCatchVariables', note: 'catch variables become `unknown`' },
  { flag: 'noImplicitAny', note: 'every untyped parameter becomes an error' },
  { flag: 'strictNullChecks', note: 'usually the biggest step: null/undefined must be handled' },
  {
    flag: 'strictPropertyInitialization',
    note: 'class fields must be initialized (needs strictNullChecks)',
  },
];

export interface EscapeHatches {
  anys: number;
  ignores: number;
  catches: number;
}

function countHatches(ctx: RepoContext): EscapeHatches {
  const out: EscapeHatches = { anys: 0, ignores: 0, catches: 0 };
  const files = ctx
    .filesWithExt('.ts', '.tsx', '.mts', '.cts')
    .filter((f) => !f.endsWith('.d.ts') && !isFixturePath(f))
    .slice(0, 3000);
  for (const f of files) {
    const text = ctx.read(f);
    if (!text) continue;
    out.anys += (text.match(/:\s*any\b|as any\b|<any>/g) ?? []).length;
    out.ignores += (text.match(/(?:\/\/|\/\*+)\s*@ts-ignore/g) ?? []).length;
    out.catches += (text.match(/\bcatch\s*\(\s*\w+\s*\)/g) ?? []).length;
  }
  return out;
}

/** One plan per product tsconfig that does not resolve to `strict: true`. */
export function strictMigrationPlans(ctx: RepoContext): StrictPlan[] {
  if (!ctx.languages.includes('typescript')) return [];
  const plans: StrictPlan[] = [];
  for (const tsconfig of projectTsconfigs(ctx)) {
    const opts = resolveCompilerOptions(ctx, tsconfig);
    if (opts.strict === true) continue;
    plans.push({
      tsconfig,
      steps: FLAGS.map(({ flag, note }) => ({ flag, note, done: opts[flag] === true })),
      preview: `npx tsc --noEmit -p ${tsconfig} --<flag>`,
    });
  }
  return plans;
}

/** Plain-text rendering for the `--fix` output. */
export function renderStrictPlans(ctx: RepoContext, plans: StrictPlan[]): string[] {
  if (plans.length === 0) return [];
  const hatches = countHatches(ctx);
  const lines: string[] = [
    'TypeScript strict-mode migration plan (report only: agent-ready never edits your tsconfig)',
  ];
  const width = Math.max(...FLAGS.map((f) => f.flag.length));
  for (const plan of plans.slice(0, 5)) {
    const done = plan.steps.filter((s) => s.done).length;
    lines.push('', `  ${plan.tsconfig}: ${done} of ${plan.steps.length} strict flags already on`);
    let n = 0;
    for (const s of plan.steps) {
      if (s.done) continue;
      n++;
      let note = s.note;
      if (s.flag === 'useUnknownInCatchVariables' && hatches.catches)
        note += ` (~${hatches.catches} catch clause(s))`;
      lines.push(`    ${String(n).padStart(2)}. ${s.flag.padEnd(width)}  ${note}`);
    }
    lines.push(
      `    Preview a step's errors without editing anything: \`${plan.preview.replace('<flag>', plan.steps.find((s) => !s.done)?.flag ?? 'strict')}\``,
    );
  }
  if (plans.length > 5) lines.push('', `  …and ${plans.length - 5} more tsconfig(s)`);
  lines.push(
    '',
    '  Enable one flag per PR and fix its errors, then replace the flags with "strict": true.',
  );
  if (hatches.anys + hatches.ignores > 0) {
    lines.push(
      `  Escape hatches to burn down along the way: ${hatches.anys} \`any\`, ${hatches.ignores} @ts-ignore.`,
    );
  }
  return lines;
}
