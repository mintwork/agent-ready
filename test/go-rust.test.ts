import { describe, expect, it } from 'vitest';
import { goAnyCount, rustUnsafeCount, tomlArray } from '../src/checks/go-rust.js';
import { scan } from '../src/scan.js';
import type { Report } from '../src/types.js';
import { fixture } from './helpers.js';

function check(report: Report, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

/** `n` lines of plain Go. */
function goLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `var v${i} = ${i}`).join('\n');
}

describe('Go interface{}/any counting', () => {
  it('counts empty interfaces and any as a type, not generic constraints, comments or strings', () => {
    const src = [
      'package x',
      'func F(v interface{}) {}',
      'func G(m map[string]any, xs ...any) []any { return nil }',
      'type Box[T any] struct{ v T }',
      'func Map[K comparable, V any](m map[K]V) {}',
      'func Pair[K, V any]() {}',
      '// interface{} in a comment',
      'var s = "any interface{}"',
      'type I interface{ M() }',
    ].join('\n');
    expect(goAnyCount(src)).toBe(4);
  });

  it('scores dense any usage lower and ignores tests and generated code', async () => {
    const heavy = Array.from(
      { length: 40 },
      (_, i) => `func F${i}(v any) interface{} { return v }`,
    );
    const r = await scan(
      fixture(null, {
        git: true,
        files: {
          'go.mod': 'module example.com/x\n',
          'x.go': `package x\n${heavy.join('\n')}\n`,
          'x_test.go': `package x\n${heavy.join('\n')}\n`,
          'api.pb.go': `package x\n${heavy.join('\n')}\n`,
        },
      }),
    );
    const c = check(r, 'types.go-any');
    expect(c.score).toBeCloseTo(0.7);
    expect(c.summary).toMatch(/^80 interface\{\}\/any/);
    expect(c.findings?.map((f) => f.file)).toEqual(['x.go']);
    const clean = await scan(
      fixture(null, {
        git: true,
        files: { 'go.mod': 'module x\n', 'x.go': `package x\n${goLines(500)}\nfunc F(v any) {}\n` },
      }),
    );
    expect(check(clean, 'types.go-any').score).toBe(1);
  });
});

describe('Rust unsafe counting', () => {
  it('counts unsafe blocks, fns and impls but not comments, strings or identifiers', () => {
    const src = [
      'unsafe fn a() {}',
      'fn b() { unsafe { a() } }',
      'unsafe impl Send for X {}',
      '// unsafe { }',
      'let s = "unsafe {";',
      'fn not_unsafe_at_all() {}',
    ].join('\n');
    expect(rustUnsafeCount(src)).toBe(3);
  });

  it('scores dense unsafe lower, skips -sys crates, and trusts forbid(unsafe_code)', async () => {
    const unsafeHeavy = Array.from({ length: 30 }, (_, i) => `fn f${i}() { unsafe { g() } }`).join(
      '\n',
    );
    const base = {
      'Cargo.toml': '[package]\nname = "x"\n',
      'src/lib.rs': `${unsafeHeavy}\n`,
      'ffi-sys/src/lib.rs': `${unsafeHeavy}\n`,
    };
    const r = await scan(fixture(null, { git: true, files: base }));
    const c = check(r, 'types.rust-unsafe');
    expect(c.score).toBeCloseTo(0.7);
    expect(c.summary).toMatch(/^30 unsafe/);
    const forbidden = await scan(
      fixture(null, {
        git: true,
        files: { ...base, 'src/lib.rs': `#![forbid(unsafe_code)]\n${unsafeHeavy}\n` },
      }),
    );
    expect(check(forbidden, 'types.rust-unsafe')).toMatchObject({
      score: 1,
      summary: 'unsafe_code is forbidden',
    });
  });
});

describe('feedback.cargo-workspace', () => {
  const crate = (name: string, deps = '') =>
    `[package]\nname = "${name}"\n\n[dependencies]\n${deps}`;

  it('passes when the root workspace reaches every crate (globs, path deps, fuzz)', async () => {
    const r = await scan(
      fixture(null, {
        git: true,
        files: {
          'Cargo.toml': '[workspace]\nmembers = [\n  "crates/*",\n]\nexclude = ["crates/old"]\n',
          'crates/a/Cargo.toml': crate('a', 'helper = { path = "../../helper" }\n'),
          'crates/a/src/lib.rs': 'pub fn a() {}\n',
          'crates/old/Cargo.toml': crate('old'),
          'helper/Cargo.toml': crate('helper'),
          'helper/src/lib.rs': 'pub fn h() {}\n',
          'fuzz/Cargo.toml': '[package]\nname = "fuzz"\n\n[workspace]\nmembers = ["."]\n',
        },
      }),
    );
    const c = check(r, 'feedback.cargo-workspace');
    expect(c.score).toBe(1);
    expect(c.summary).toBe('All 2 crates are in the root workspace');
  });

  it('flags nested workspaces and orphan crates', async () => {
    const r = await scan(
      fixture(null, {
        git: true,
        files: {
          'Cargo.toml': '[workspace]\nmembers = ["core"]\n',
          'core/Cargo.toml': crate('core'),
          'core/src/lib.rs': 'pub fn c() {}\n',
          'tools/lint/Cargo.toml': `${crate('lint')}\n[workspace]\n`,
          'tools/lint/src/main.rs': 'fn main() {}\n',
          'stray/Cargo.toml': crate('stray'),
          'stray/src/lib.rs': 'pub fn s() {}\n',
        },
      }),
    );
    const c = check(r, 'feedback.cargo-workspace');
    expect(c.score).toBeCloseTo(1 / 3);
    expect(c.findings?.map((f) => [f.file, f.message.split(':')[0]])).toEqual([
      ['tools/lint/Cargo.toml', 'separate workspace with 1 crate(s)'],
      ['stray/Cargo.toml', 'crate is in no workspace'],
    ]);
  });

  it('is n/a for a single crate', async () => {
    const r = await scan(
      fixture(null, { files: { 'Cargo.toml': crate('x'), 'src/main.rs': 'fn main() {}\n' } }),
    );
    expect(check(r, 'feedback.cargo-workspace').score).toBeNull();
  });

  it('parses multi-line TOML arrays in the right section', () => {
    const toml = '[package]\nmembers = ["no"]\n[workspace]\nmembers = [\n "a", # c\n "b/*"\n]\n';
    expect(tomlArray(toml, 'workspace', 'members')).toEqual(['a', 'b/*']);
  });
});
