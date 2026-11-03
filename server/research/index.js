import { searchers, readSource, availableKinds } from './sources.js';
import { createAnalyst } from './analyst.js';

// The live research backend the brain's agents call: search, read, analyze.
export function createResearch({ analyst = createAnalyst() } = {}) {
  return {
    kinds: availableKinds(),
    analyst,
    search: (kind, query) => searchers[kind](query),
    read: readSource,
  };
}
