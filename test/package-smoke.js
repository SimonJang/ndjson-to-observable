'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repository = path.join(__dirname, '..');
const packageName = require('../package.json').name;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-to-observable-package-'));

const run = (command, args, cwd) => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		timeout: 120000
	});

	assert.equal(result.status, 0, [
		result.error && result.error.stack,
		result.stdout,
		result.stderr
	].filter(Boolean).join('\n'));
	return result.stdout;
};

try {
	const packResult = JSON.parse(run('npm', [
		'pack',
		'--ignore-scripts',
		'--json',
		'--pack-destination',
		temporaryDirectory
	], repository));
	const packed = Array.isArray(packResult) ? packResult[0] : packResult[packageName];

	assert.ok(packed, 'npm pack did not return package metadata');
	const packedFiles = packed.files.map(file => file.path);

	assert.ok(packedFiles.includes('lib/index.js'));
	assert.ok(packedFiles.includes('lib/index.d.ts'));

	const consumer = path.join(temporaryDirectory, 'consumer');
	fs.mkdirSync(consumer);
	fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({private: true}));
	fs.writeFileSync(path.join(consumer, 'consumer.ts'), [
		"import { Readable } from 'stream';",
		"import { Observable } from 'rxjs';",
		"import { ndjsonToObservable } from 'ndjson-to-observable';",
		'',
		'declare const input: Readable;',
		'const result: Observable<{id: number}> = ndjsonToObservable<{id: number}>(input);',
		'void result;',
		''
	].join('\n'));

	run('npm', [
		'install',
		'--ignore-scripts',
		'--package-lock=false',
		'--no-audit',
		'--no-fund',
		path.join(temporaryDirectory, packed.filename),
		'rxjs@6.5.3',
		'@types/node@22.20.1'
	], consumer);
	run(process.execPath, [
		'-e',
		"require('assert').strictEqual(typeof require('ndjson-to-observable').ndjsonToObservable, 'function')"
	], consumer);
	run(process.execPath, [
		path.join(repository, 'node_modules', 'typescript', 'bin', 'tsc'),
		'--noEmit',
		'--strict',
		'--target',
		'ES2017',
		'--module',
		'node16',
		'--moduleResolution',
		'node16',
		'--types',
		'node',
		path.join(consumer, 'consumer.ts')
	], consumer);
} finally {
	fs.rmSync(temporaryDirectory, {recursive: true, force: true});
}
