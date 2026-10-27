// Engine registry. To add an engine: create engines/assessment/<name>.js exporting a factory that
// returns an object matching interface.md, register it below, set ASSESSMENT_ENGINE=<name>.
import { createMockEngine } from './mock.js';
import { createToneperfectEngine } from './toneperfect.js';
import { withPolicy } from './policy.js';
export { deriveFacts } from './derive.js';
export { applyPolicy, withPolicy } from './policy.js';

const registry = {
  mock: () => createMockEngine(),
  toneperfect: (cfg) => createToneperfectEngine(cfg),
};

export function createAssessmentEngine(cfg) {
  const make = registry[cfg.assessmentEngine];
  if (!make) throw new Error(`Unknown assessment engine: ${cfg.assessmentEngine}`);
  return withPolicy(make(cfg), cfg.policy); // policy applies to ANY engine, after normalization
}
export const engineNames = () => Object.keys(registry);
