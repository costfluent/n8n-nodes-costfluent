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
		coverage: {
			provider: 'v8',
			// The .node.json files are n8n's codex metadata, not code.
			include: ['nodes/**/*.ts', 'credentials/**/*.ts'],
			reporter: ['text-summary'],
			// The figures of 2026-11-13 (lines 98.23%, branches 94.81%), rounded down.
			thresholds: { lines: 98, branches: 94 },
		},
	},
});
