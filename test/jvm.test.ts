import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCommands } from '../src/checks/context-docs.js';
import { testCommand, typecheckCommand } from '../src/checks/feedback.js';
import { createContext } from '../src/context.js';
import { generateAgentsMd } from '../src/fix/agents-md.js';
import { scan } from '../src/scan.js';
import type { Report } from '../src/types.js';
import { fixture } from './helpers.js';

function check(report: Report, id: string) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

const javaClass = (name: string) => `package app;\n\npublic class ${name} {}\n`;

function maven(extra: Record<string, string> = {}): string {
  return fixture(null, {
    git: true,
    files: {
      'pom.xml':
        '<project><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin></plugins></build></project>\n',
      mvnw: '#!/bin/sh\n',
      'src/main/java/app/App.java': javaClass('App'),
      'src/main/java/app/Util.java': javaClass('Util'),
      'src/test/java/app/AppTest.java': javaClass('AppTest'),
      ...extra,
    },
  });
}

describe('Java/Kotlin detection', () => {
  it('detects Java from a root Maven build and scores its feedback loops', async () => {
    const dir = maven();
    expect(testCommand(createContext(dir))).toBe('./mvnw test');
    expect(typecheckCommand(createContext(dir))).toBe('./mvnw compile');
    const r = await scan(dir);
    expect(r.languages).toEqual(['java']);
    expect(check(r, 'feedback.test')).toMatchObject({
      score: 1,
      summary: 'Tests: `./mvnw test` (1 test files)',
    });
    expect(check(r, 'feedback.lint').score).toBe(1);
    expect(check(r, 'feedback.typecheck').summary).toBe('Typecheck: `./mvnw compile`');
    expect(check(r, 'types.static').summary).toBe(
      'Java: statically typed, checked by the compiler',
    );
  });

  it('detects Kotlin with Gradle and asks for a linter and tests', async () => {
    const r = await scan(
      fixture(null, {
        git: true,
        files: {
          'settings.gradle.kts': 'rootProject.name = "k"\n',
          'build.gradle.kts': 'plugins { kotlin("jvm") }\n',
          'src/main/kotlin/App.kt': 'fun main() {}\n',
        },
      }),
    );
    expect(r.languages).toEqual(['kotlin']);
    expect(check(r, 'feedback.test')).toMatchObject({ score: 0 });
    expect(check(r, 'feedback.lint').score).toBe(0.6);
    expect(check(r, 'feedback.typecheck').summary).toBe('Typecheck: `gradle classes`');
  });

  it('does not make a JS app with a small android/ folder a Java project', async () => {
    const r = await scan(
      fixture('good-ts', {
        git: true,
        files: {
          'android/build.gradle': 'apply plugin: "com.android.application"\n',
          'android/app/src/main/java/com/app/MainActivity.java': javaClass('MainActivity'),
        },
      }),
    );
    expect(r.languages).not.toContain('java');
  });

  it('generates and recognizes JVM commands in context docs', () => {
    const md = generateAgentsMd(createContext(maven()));
    expect(md).toContain('./mvnw package -DskipTests');
    expect(md).toContain('./mvnw test');
    expect([...detectCommands('```\n./mvnw test\n./mvnw package\n```')].sort()).toEqual([
      'build',
      'test',
    ]);
  });

  it('flags an unignored Maven target/ directory', async () => {
    const dir = maven({ '.gitignore': '.idea/\n' });
    // build output appears after `git add`, so it is untracked (and not ignored)
    mkdirSync(join(dir, 'target/classes'), { recursive: true });
    writeFileSync(join(dir, 'target/classes/App.class'), 'x');
    const r = await scan(dir);
    const nav = check(r, 'nav.gitignore');
    expect(nav.findings?.some((f) => f.message.includes('add `target/`'))).toBe(true);
  });
});
