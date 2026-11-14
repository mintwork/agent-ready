import type { Check } from '../types.js';
import { contextChecks } from './context-docs.js';
import { feedbackChecks } from './feedback.js';
import { navigabilityChecks } from './navigability.js';
import { runChecks } from './run-checks.js';
import { safetyChecks } from './safety.js';
import { typeSafetyChecks } from './type-safety.js';

/** Built-in checks. Add new ones here (or pass your own array to `scan`). */
export const builtinChecks: Check[] = [
  ...contextChecks,
  ...feedbackChecks,
  ...navigabilityChecks,
  ...typeSafetyChecks,
  ...safetyChecks,
  ...runChecks,
];
