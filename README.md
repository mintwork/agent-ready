<div align="center">

# agent-ready

**Lighthouse for AI coding agents.**
Score how well Claude Code, Codex and Cursor can work in your repo — then auto-fix the gaps.

[![CI](https://github.com/mintwork/agent-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/mintwork/agent-ready/actions/workflows/ci.yml) [![Codacy grade](https://app.codacy.com/project/badge/Grade/f727918f28954b8d984d25352a6d9be9)](https://app.codacy.com/gh/mintwork/agent-ready/dashboard) [![npm](https://img.shields.io/npm/v/@mintwork/agent-ready?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@mintwork/agent-ready) [![npm downloads](https://img.shields.io/npm/dm/@mintwork/agent-ready?color=cb3837&logo=npm&label=downloads)](https://www.npmjs.com/package/@mintwork/agent-ready) [![npm provenance](https://img.shields.io/badge/provenance-signed-7EE2B8?labelColor=0D1714&logo=sigstore&logoColor=white)](https://www.npmjs.com/package/@mintwork/agent-ready#provenance) [![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![agent-ready: 100/100](https://img.shields.io/badge/agent--ready-100%2F100-brightgreen)](https://github.com/mintwork/agent-ready) [![zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-7EE2B8?labelColor=0D1714)](package.json) [![GitHub stars](https://img.shields.io/github/stars/mintwork/agent-ready?style=social)](https://github.com/mintwork/agent-ready/stargazers)

<img src="docs/demo.gif" alt="agent-ready scoring a repo at 59/100, running --fix to reach 78/100, then printing a README badge" width="900">

```bash
npx @mintwork/agent-ready
```

</div>

---

Your agent is only as good as the repo you drop it into. No `AGENTS.md`? It guesses your test
command. Stale `CLAUDE.md`? It confidently edits files that were deleted months ago. `dist/` not
ignored? It greps your minified bundle and burns half its context window. A `build` script that
runs `npm publish`? Good luck.

`agent-ready` checks all of that in **under a second** and gives you a 0–100 score, a category
breakdown, and a punch list of fixes — many of which it can apply for you.

## What it looks like

```text
$ npx @mintwork/agent-ready ~/code/acme-api

  agent-ready v0.2.0  ~/code/acme-api
  8 files · typescript · 94ms

  Agent-ready score  59/100  ██████████████░░░░░░░░░░  Fair

  Context docs       0  ░░░░░░░░░░░░░░░░░░░░  weight 30%
  Feedback loops    78  ████████████████░░░░  weight 25%
  Navigability      85  █████████████████░░░  weight 20%
  Type safety       85  █████████████████░░░  weight 15%
  Safety           100  ████████████████████  weight 10%

  Context docs
   ✗ Agent context file present (0%) — No agent context file (AGENTS.md / CLAUDE.md / .cursor/rules)
       → Run `agent-ready --fix` to generate a starter AGENTS.md + CLAUDE.md.  [fixable: --fix]
   ✗ 5 more check(s) (context.commands, context.architecture, context.fresh, context.length,
     context.coverage) score 0 until a context file exists

  Feedback loops
   ✗ Linter configured (0%) — Lint: no JS linter
       → Configure a fast linter (eslint/biome for JS, ruff for Python, clippy for Rust, ...) and run it in CI.

  Navigability
   ! Build/dependency output is ignored (50%) — 1 ignore problem(s)
       · No .gitignore — agents will search build output and dependencies
       → Run `agent-ready --fix` to add the missing .gitignore entries.  [fixable: --fix]

  Type safety
   ! TypeScript strictness (85%) — strict mode on (tsconfig.json); 3 any, 0 @ts-ignore
       → Burn down `any` and `@ts-ignore` escape hatches.

  Next: agent-ready --fix to auto-fix 5 check(s) · agent-ready --badge for a README badge · --verbose for passing checks
```

Then:

```text
$ npx @mintwork/agent-ready --fix

Created AGENTS.md — Starter AGENTS.md generated from detected scripts and structure
Created CLAUDE.md — CLAUDE.md that imports AGENTS.md for Claude Code
Created .gitignore — Create .gitignore so dependency/build dirs stay out of agent context

  Score: 59 → 78
  Fill in the TODO sections in AGENTS.md to unlock the remaining +14 points.
```

(Diffs omitted. This is the synthetic `acme-api` repo from the demo above.)

## Show off your score

```bash
npx @mintwork/agent-ready --badge
```

```markdown
[![agent-ready: 94/100](https://img.shields.io/badge/agent--ready-94%2F100-brightgreen)](https://github.com/mintwork/agent-ready)
```

Paste it at the top of your README. It tells contributors — human and AI — that your repo is
ready for them. (This repo scores 100/100, and CI fails if it drops below 90.)

## Install

```bash
npx @mintwork/agent-ready            # no install
npm i -D @mintwork/agent-ready       # or pin it in your project
```

Node 22+. Zero runtime dependencies. Works on JS/TS, Python, Go and Rust repos, with basic Java/Kotlin
support, and understands monorepos. Read-only unless you pass `--fix`.

## Usage

```text
npx @mintwork/agent-ready [path] [options]

  --json             Machine-readable JSON report
  --badge            Print a shields.io badge (markdown) for your README
  --sarif            SARIF 2.1.0 report for GitHub code scanning
  --fix              Apply safe auto-fixes (AGENTS.md/CLAUDE.md, .gitignore, .cursorignore/.ignore,
                     .env.example) and print a TypeScript strict-mode migration plan
  --dry-run          With --fix: show the diff without writing
  --force            With --fix: allow overwriting existing files
  --run              Execute the test, lint and typecheck commands (opt-in: runs project code)
  --flaky            With --run: run the tests twice and flag flaky results
  --timeout <s>      With --run: per-command timeout in seconds (default 300)
  --min-score <n>    Exit 1 if the score is below n (CI gating)
  --verbose, -v      Show passing checks and all findings
  --no-color         Disable colors
  --version          Print version
  --help, -h         Show this help
```

`--sarif` can't be combined with `--json` or `--badge`.

**`--fix` is conservative.** It creates missing files and appends to existing ones (`.gitignore`,
missing sections in your context doc). It never rewrites content you wrote unless you pass
`--force`, and it always prints a diff. Generated docs never recommend scripts that publish or delete.

It also:

- **Hides committed generated code** (minified bundles, vendored libraries, `generated/` dirs) by
  appending it to `.cursorignore` (Cursor) and `.ignore` (ripgrep, used by Claude Code and Codex).
  The files stay in git.
- **Writes `.env.example`** from the environment variables your code reads (`process.env.X`,
  `import.meta.env.X`, `os.getenv`, `os.Getenv`, `env::var`). It only does this when the project
  loads `.env` files and has no template yet. It writes names only: values from your local `.env`
  are never copied.
- **Prints a TypeScript strict-mode migration plan** when a tsconfig isn't `strict`. The plan lists
  the remaining strict flags in a sensible order, each with the `tsc --noEmit --<flag>` command that
  previews its errors. It never edits your tsconfig.

## What it checks

The score is a weighted average of five categories:

| Category           | Weight | What it asks                                                        |
| ------------------ | ------ | ------------------------------------------------------------------- |
| **Context docs**   | 30%    | Do the agent instructions exist, and are they correct and current?  |
| **Feedback loops** | 25%    | Can an agent find and run the tests, linter and typechecker?        |
| **Navigability**   | 20%    | Does search return product code rather than build output and blobs? |
| **Type safety**    | 15%    | Will the compiler catch the agent's mistakes?                       |
| **Safety**         | 10%    | Can an agent leak a secret or run something destructive?            |

Every check, by id (use the ids with `disable` in the [configuration](#configuration)):

| Check                       | Category       | What it checks                                                                                                                                                       |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.exists`            | Context docs   | `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` / Copilot / Gemini instructions exist                                                                                    |
| `context.commands`          | Context docs   | They list exact build, test and lint commands                                                                                                                        |
| `context.architecture`      | Context docs   | They describe the architecture and key directories                                                                                                                   |
| `context.fresh`             | Context docs   | Not stale: every referenced path and `npm run` script exists                                                                                                         |
| `context.drift`             | Context docs   | Not drifting (git history): no doc untouched for 90+ days while 25+ later commits changed the files it names or added/removed files in the directories it describes  |
| `context.length`            | Context docs   | Not too long (or too thin) to fit in context                                                                                                                         |
| `context.coverage`          | Context docs   | Both `AGENTS.md` and `CLAUDE.md`, so every agent is covered                                                                                                          |
| `context.cursor-rules`      | Context docs   | Every `.cursor/rules/*.mdc` applies (frontmatter with `alwaysApply`, a `description` or globs that match files) and isn't empty                                      |
| `context.packages`          | Context docs   | Monorepos: large workspace packages have their own `AGENTS.md`/`CLAUDE.md` or are mentioned in the root docs                                                         |
| `feedback.test`             | Feedback loops | A discoverable test command (package.json `test`, pytest config, `make test`, `cargo test`, `go test`, `mvn test` / `./gradlew test`)                                |
| `feedback.lint`             | Feedback loops | A linter is configured (eslint, biome, oxlint, ruff, flake8, clippy, golangci-lint, checkstyle, spotless, PMD, SpotBugs, Error Prone, ktlint, detekt)                |
| `feedback.typecheck`        | Feedback loops | A typecheck command (`tsc`, mypy, pyright, `go vet`/`go build`, `cargo check`, Maven/Gradle compile)                                                                 |
| `feedback.ci`               | Feedback loops | CI runs the checks                                                                                                                                                   |
| `feedback.mcp`              | Feedback loops | `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` parse, servers have a `command` or http(s) `url`, local scripts exist, credentials are `${VAR}` expansions    |
| `feedback.hooks`            | Feedback loops | Claude Code hooks in `.claude/settings.json` use real event names, valid matcher regexes, the right shape and scripts that exist                                     |
| `feedback.cargo-workspace`  | Feedback loops | Rust: one cargo workspace reaches every crate (nested workspaces and orphan crates are flagged; path deps and `fuzz/` are understood)                                |
| `feedback.speed`            | Feedback loops | `--run`: the test suite passes, and fast                                                                                                                             |
| `feedback.lint-passes`      | Feedback loops | `--run`: the lint command passes                                                                                                                                     |
| `feedback.typecheck-passes` | Feedback loops | `--run`: the typecheck command passes                                                                                                                                |
| `feedback.flaky`            | Feedback loops | `--flaky`: the tests give the same result twice in a row                                                                                                             |
| `nav.gitignore`             | Navigability   | `node_modules`, `.venv`, `dist`, `target`, caches are ignored (and not committed)                                                                                    |
| `nav.large-files`           | Navigability   | No source files over 1000 lines                                                                                                                                      |
| `nav.generated`             | Navigability   | No minified, vendored or generated blobs in agent view                                                                                                               |
| `nav.depth`                 | Navigability   | A shallow, navigable directory tree                                                                                                                                  |
| `nav.readme`                | Navigability   | A README exists                                                                                                                                                      |
| `types.typescript`          | Type safety    | TypeScript `strict` across root and package tsconfigs (follows `extends`), `any` / `@ts-ignore` / `@ts-nocheck` density; plain JS is penalized                       |
| `types.python`              | Type safety    | Python type-hint coverage of product code, plus a mypy/pyright config                                                                                                |
| `types.static`              | Type safety    | Go, Rust, Java and Kotlin count as compiler-checked                                                                                                                  |
| `types.go-any`              | Type safety    | Go: `interface{}`/`any` used as a type, per 1000 lines (generic constraints, tests and generated code don't count)                                                   |
| `types.rust-unsafe`         | Type safety    | Rust: `unsafe` blocks/fns/impls per 1000 lines (`-sys` crates skipped; `forbid(unsafe_code)` scores 1)                                                               |
| `safety.secrets`            | Safety         | No committed `.env` / key / credentials files, and no AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, Google or npm token patterns                                    |
| `safety.scripts`            | Safety         | No dangerous scripts: `rm -rf ~`, `curl \| sh`, force-push, `npm publish` hidden in `build`/`test`, network calls in install hooks                                   |
| `safety.agent-permissions`  | Safety         | Committed agent permissions are scoped: no `Bash`/`Bash(*)` allow rules, `bypassPermissions`, pre-approved shells/`rm`/`curl`/`git push`, Codex `danger-full-access` |

**`--run` executes project code**, so it is opt-in. It runs the test command (timed), the lint
command and the typecheck command the report detected (package.json scripts, `make` targets,
ruff/mypy, `go vet`/`go build`, `cargo clippy`/`cargo check`, `mvn compile`/`./gradlew classes`). Scripts that publish or delete are
never run. `--flaky` runs the test suite a second time and compares the results, including which
tests failed for vitest/jest, pytest, `go test`, `cargo test` and TAP output. Each command gets a
timeout (`--timeout`, default 300s), and on timeout the whole process tree is killed. Only use
`--run` on repos you trust.

Doc drift reads local `git log` only and never touches the network. It is n/a in shallow clones,
so set `fetch-depth: 0` on `actions/checkout` if you want it in CI (as in the workflow below).

Checks that don't apply (e.g. Python checks in a TS repo) are marked n/a and excluded from the score.
Agent-tooling checks (MCP, hooks, permissions, Cursor rules) are n/a unless the repo ships that
config, so you're never penalized for not using a tool.
In polyglot repos, per-language parts are weighted by each language's share of the code, so a tooling
`package.json` in a Rust repo doesn't count as much as the Rust itself. Secrets in tests, fixtures and
examples are listed (with `--verbose`) but don't lower the score.

**Monorepos.** npm, pnpm, yarn and bun workspaces, Cargo workspaces and Go multi-module repos
(`go.work`, or nested `go.mod`) are detected automatically. Each package is also scored on its own
for feedback loops, navigability and type safety, with root linter/TypeScript configs and root
`package.json` scripts counted as covering it. The report shows a per-package breakdown and a
code-size-weighted aggregate (`workspaces` in `--json`); the headline score stays repo-wide.
Examples, test helpers and docs packages are skipped.

```text
  Workspaces  pnpm · 13 package(s) · aggregate 93/100
    packages/expect      84  ████████░░  in root docs · no oversized source files (>1000 lines)
    packages/vitest      89  █████████░  in root docs · no oversized source files (>1000 lines)
```

**Generated docs earn partial credit.** An `AGENTS.md` created by `--fix` still carries a
`Generated by agent-ready` marker and TODO placeholders. Until a human edits it, the content checks
(context file present, commands, architecture, freshness, length) score at most 50%, so `--fix`
alone can't pass for hand-written context. Credit comes back as you replace the TODOs with real
content: it scales with the share of TODOs filled in _and_ the amount of new text you write (deleting
the TODOs without writing anything earns nothing), and the last 10% unlocks when you remove the
marker. The report shows what's left: `Fill in the TODO sections in AGENTS.md to unlock the
remaining +14 points.`

"Agent-visible" means what ripgrep-based agents actually see: `git ls-files` minus anything in
`.gitignore`, `.ignore`, `.rgignore` or `.cursorignore`.

## CI: fail PRs that make your repo worse for agents

Use the GitHub Action ([Agent Readiness Score](https://github.com/marketplace/actions/agent-readiness-score)
on the Marketplace):

```yaml
# .github/workflows/agent-ready.yml
name: agent-ready
on: [pull_request]
permissions:
  contents: read
  security-events: write # only needed for sarif: true
jobs:
  agent-ready:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 } # full history for the doc drift check
      - uses: mintwork/agent-ready@v0
        with:
          min-score: 75
          sarif: true
```

| Input            | Default              | Description                                                                       |
| ---------------- | -------------------- | --------------------------------------------------------------------------------- |
| `path`           | `.`                  | Directory to scan                                                                 |
| `min-score`      | `0`                  | Fail the job if the score is below this (0–100)                                   |
| `version`        | the action's version | `@mintwork/agent-ready` npm version to run                                        |
| `sarif`          | `false`              | Also upload the findings to GitHub code scanning (needs `security-events: write`) |
| `sarif-category` | `agent-ready`        | Code scanning category for the upload (use a different one per scanned `path`)    |

| Output       | Description                                   |
| ------------ | --------------------------------------------- |
| `score`      | The agent-ready score (0–100)                 |
| `sarif-file` | Path of the SARIF report (when `sarif: true`) |

The job summary shows the score and a README badge. With `sarif: true`, findings show up as
code scanning alerts on the files they're about, and they are uploaded even when the score gate
fails, so the alerts explain the failure. `--sarif` reports every check as a rule and every
finding of a check that isn't fully passing as a result. Repo-level problems (no CI, no context
file) are anchored at your `AGENTS.md`/`README.md`. Safety checks carry a `security-severity`, so
leaked secrets rank as high-severity alerts.

`@v0` tracks the latest 0.x release; pin `@v0.2.0` for a fixed version. The action runs the
agent-ready release matching the tag you use, unless you override it with `version`.

Without the action, run the CLI directly:

```yaml
- run: npx --yes @mintwork/agent-ready@latest . --min-score 75
```

See [`examples/github-action.yml`](examples/github-action.yml).

## Configuration

Optional `agent-ready.config.json` (or an `"agent-ready"` key in package.json):

```json
{
  "ignore": ["test/fixtures/**", "vendor/**"],
  "disable": ["nav.depth", "types"]
}
```

`disable` takes check ids (`--verbose` and `--json` show them) or whole categories. Silence a single
secret false positive with an `agent-ready-ignore` comment on the same line.

## Programmatic API

```ts
import { scan, builtinChecks, type Check } from '@mintwork/agent-ready';

const noTodos: Check = {
  id: 'custom.no-todo-md',
  category: 'context',
  title: 'No TODO.md left lying around',
  weight: 1,
  run: (ctx) =>
    ctx.has('TODO.md') ? { score: 0, summary: 'TODO.md found' } : { score: 1, summary: 'clean' },
};

const report = await scan('.', { checks: [...builtinChecks, noTodos] });
console.log(report.score, report.categories);
```

Every check is a plain object with `run(ctx)` returning a 0–1 score and optional `fix(ctx)` that
proposes file changes. Adding one is ~30 lines — see [CONTRIBUTING.md](CONTRIBUTING.md).

## How is this different from a linter?

ESLint tells you your code is wrong. `agent-ready` tells you your **repo** is hard to work in —
for the coworker who reads every file literally, never asks a clarifying question, and runs
whatever `npm run build` does.

## Roadmap

- [ ] Public leaderboard of popular open-source repos

Shipped features are in the [CHANGELOG](CHANGELOG.md).

Ideas and PRs welcome — especially new checks backed by real agent failure modes.

## License

MIT
