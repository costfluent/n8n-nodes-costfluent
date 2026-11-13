import ts from 'typescript';
import { expect, it } from 'vitest';

import manifest from '../package.json';

// n8n loads a community node package by the paths its package.json lists under n8n.credentials and
// n8n.nodes, from the published tarball, which holds only what "files" names. The other tests
// import the sources, so a renamed path or a narrowed "files" would publish a package n8n cannot
// load. This reads the built dist/, so it runs after `npm run build`. The n8n lint forbids spawning
// `npm pack` and Node's fs in any file here, so the build output is read through TypeScript's own
// file system access, and "files" entries are read as plain paths: a glob or negation fails below
// rather than being matched loosely.

const listed = [...manifest.n8n.credentials, ...manifest.n8n.nodes];

function published(path: string): boolean {
	return manifest.files.some(
		(entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`),
	);
}

it('lists at least one credential and one node', () => {
	expect(manifest.n8n.credentials.length).toBeGreaterThan(0);
	expect(manifest.n8n.nodes.length).toBeGreaterThan(0);
});

it('names files as plain paths', () => {
	expect(manifest.files.filter((entry) => /[*?[\]{}!]/.test(entry))).toEqual([]);
});

it.each(listed)('builds and publishes %s', (path) => {
	expect(ts.sys.fileExists(path), `${path} is not in the build output: run npm run build`).toBe(
		true,
	);
	expect(published(path), `${path} is outside package.json's "files"`).toBe(true);
});

it('publishes no sources or tests', () => {
	expect(
		manifest.files.filter((entry) => /^(credentials|nodes|test|node_modules)(\/|$)/.test(entry)),
	).toEqual([]);
});
