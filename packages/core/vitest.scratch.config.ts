import base from './vitest.config.ts';
const t = { ...(base as { test: Record<string, unknown> }).test };
delete t['globalSetup'];
t['silent'] = false;
t['reporters'] = ['default'];
t['coverage'] = { enabled: false };
export default { ...base, test: t };
