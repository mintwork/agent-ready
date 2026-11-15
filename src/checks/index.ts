import type { Check } from '../types.js';
import { agentToolingChecks } from './agent-tooling.js';
import { contextChecks } from './context-docs.js';
import { feedbackChecks } from './feedback.js';
import { navigabilityChecks } from './navigability.js';
import { safetyChecks } from './safety.js';
import { typeSafetyChecks } from './type-safety.js';
import { workspaceDocsCheck } from './workspace-docs.js';

/** Built-in checks. Add new ones here (or pass your own array to `scan`). */
export const builtinChecks: Check[] = [
  ...contextChecks,
  workspaceDocsCheck,
  ...feedbackChecks,
  ...navigabilityChecks,
  ...typeSafetyChecks,
  ...safetyChecks,
  ...agentToolingChecks,
];
