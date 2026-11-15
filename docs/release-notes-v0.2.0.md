# Agent Readiness Score v0.2.0

**Lighthouse for AI coding agents.** Score how well Claude Code, Codex and Cursor can work in your
repository (0–100), see exactly what to fix, and keep it from regressing in CI. 0.2.0 puts the
findings in GitHub code scanning, understands monorepos, checks your agent tooling configs, and
adds Java/Kotlin.

## Use the Action

```yaml
# .github/workflows/agent-ready.yml
name: agent-ready
on: [pull_request]
permissions:
  contents: read
  security-events: write # needed for sarif: true
jobs:
  agent-ready:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # full history for the doc drift check
      - uses: mintwork/agent-ready@v0
        with:
          min-score: 75 # fail the check below this score
          sarif: true # findings show up as code scanning alerts
```

| Input            | Default              |                                                              |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| `path`           | `.`                  | Directory to scan                                            |
| `min-score`      | `0`                  | Fail if the score is below this (0–100)                      |
| `version`        | the action's version | `@mintwork/agent-ready` npm version to run                   |
| `sarif`          | `false`              | **New.** Upload the findings to GitHub code scanning         |
| `sarif-category` | `agent-ready`        | **New.** Code scanning category (use one per scanned `path`) |

**Outputs:** `score` (0–100) and, **new**, `sarif-file` (path of the SARIF report). The job summary
shows the score and a README badge.

## Or run it locally

```bash
npx @mintwork/agent-ready          # score this repo
npx @mintwork/agent-ready --fix    # write a starter AGENTS.md / CLAUDE.md and fix ignore gaps
npx @mintwork/agent-ready --badge  # README badge
```

## What's new in 0.2.0

- **SARIF and code scanning.** `--sarif` writes a SARIF 2.1.0 report: every check is a rule, every
  finding is an alert on the file (and line) it's about. In the Action, set `sarif: true`. Alerts
  are uploaded even when the score gate fails, so they explain the failure, and leaked secrets rank
  as high severity.
- **Monorepos.** npm/pnpm/yarn/bun workspaces, Cargo workspaces and Go multi-module repos are
  detected. Each package gets its own score, and the report shows a per-package breakdown and a
  size-weighted aggregate. The headline score stays repo-wide. A new check asks large packages to
  have their own `AGENTS.md`, or a mention in the root docs.
- **Agent tooling checks.** `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` are valid and keep
  credentials out; Claude Code hooks use real event names and existing scripts; committed agent
  permissions don't pre-approve `Bash(*)`, `bypassPermissions` or Codex `danger-full-access`; Cursor
  rules actually apply. Each check is n/a unless you ship that config.
- **Smarter `--fix`.** Hides committed generated and vendored code via `.cursorignore` and `.ignore`,
  creates `.env.example` from the env vars your code reads (names only, never values), and prints a
  step-by-step TypeScript strict-mode migration plan.
- **`--run` lint and typecheck, and `--flaky`.** `--run` now also runs your lint and typecheck
  commands. `--flaky` runs the tests twice and flags tests that change result. `--timeout` sets the
  per-command limit, and the whole process tree is killed on timeout.
- **Doc drift via git history.** Flags context docs that went untouched for 90+ days while the code
  they describe kept changing. Local `git log` only; n/a in shallow clones.
- **Deeper Go and Rust checks.** `interface{}`/`any` density in Go, `unsafe` density in Rust, and one
  cargo workspace that reaches every crate.
- **Java/Kotlin support.** Maven and Gradle projects are detected and scored on tests, linters
  (checkstyle, spotless, PMD, SpotBugs, Error Prone, ktlint, detekt) and compile, and `--fix` writes
  their build and test commands.

## Will my score change?

Without `--run`, most repos score the same as on 0.1.x. New checks are n/a unless they apply. The
exceptions:

- **Java/Kotlin repos go up**, because they used to be scored on CI alone. For example, gson
  61 → 67, spring-petclinic 63 → 69 and timber 58 → 64.
- **Some Go and Rust repos go slightly down** with heavy `any` or `unsafe` use (tokio 66 → 65,
  hugo 80 → 78). Others go up when their cargo workspace check passes (ripgrep 62 → 63).
- **Doc drift** can cost a point for long-untouched docs (excalidraw 88 → 87) and adds a passing
  check for recently edited ones (openai-agents-python 85 → 86).
- **Agent tooling checks** move repos that ship those configs by a point or two (for example,
  nano-agent 44 → 46).

`@v0` now runs 0.2.0. If you gate on `min-score`, check your new score with
`npx @mintwork/agent-ready@0.2.0`. To stay on the old version for now, pin
`mintwork/agent-ready@v0.1.1`.

Full details: [Changelog](https://github.com/mintwork/agent-ready/blob/main/CHANGELOG.md) ·
[README](https://github.com/mintwork/agent-ready#readme)
