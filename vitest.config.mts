import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
	// n8n loads a community node as CommonJS, so the tests do too. n8n-workflow's ES module build
	// does not load in Node on its own, and inlined through Vite it warns about every missing source
	// map.
	resolve: { alias: { 'n8n-workflow': require.resolve('n8n-workflow') } },
	test: {
		include: ['test/**/*.test.ts'],
		server: { deps: { external: [/node_modules\/n8n-workflow\//] } },
	},
});
