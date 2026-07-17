'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {PassThrough, Readable} = require('node:stream');
const test = require('node:test');
const {ndjsonToObservable} = require('../lib');

const collect = observable => new Promise((resolve, reject) => {
	const values = [];
	observable.subscribe({
		next(value) {
			values.push(value);
		},
		error: reject,
		complete() {
			resolve(values);
		}
	});
});

const assertProcessFixture = filename => {
	const result = spawnSync(process.execPath, [path.join(__dirname, filename)], {
		encoding: 'utf8'
	});

	assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
};

test('parses LF-delimited object records', async () => {
	const input = Readable.from(['{"id":1}\n{"id":2}\n{"id":3}']);

	assert.deepEqual(await collect(ndjsonToObservable(input)), [
		{id: 1},
		{id: 2},
		{id: 3}
	]);
});

test('supports a UTF-8 BOM, CRLF, surrounding whitespace, and blank lines', async () => {
	const input = Readable.from(['\uFEFF{"id":1}\r\n\r\n  {"id":2}  \r\n']);

	assert.deepEqual(await collect(ndjsonToObservable(input)), [{id: 1}, {id: 2}]);
});

test('accepts every JSON value allowed in NDJSON records', async () => {
	const input = Readable.from(['1\ntrue\nnull\n"hello"\n[1,2]\n{"id":3}\n']);

	assert.deepEqual(await collect(ndjsonToObservable(input)), [
		1,
		true,
		null,
		'hello',
		[1, 2],
		{id: 3}
	]);
});

test('handles records and multibyte characters split across chunks', async () => {
	const input = Readable.from([
		Buffer.from('{"emoji":"\u{1F600}', 'utf8').subarray(0, 12),
		Buffer.from('{"emoji":"\u{1F600}","id":1}\n{"id":', 'utf8').subarray(12),
		Buffer.from('2}\n', 'utf8')
	]);

	assert.deepEqual(await collect(ndjsonToObservable(input)), [
		{emoji: '\u{1F600}', id: 1},
		{id: 2}
	]);
});

test('makes a malformed record terminal before later same-chunk records', async () => {
	const input = Readable.from(['{"id":1}\nnot-json\nstill-not-json\n{"id":2}\n']);
	const observable = ndjsonToObservable(input);
	const events = [];

	await new Promise(resolve => {
		observable.subscribe({
			next(value) {
				events.push(['next', value]);
			},
			error(error) {
				events.push(['error', error.name]);
				resolve();
			},
			complete() {
				events.push(['complete']);
				resolve();
			}
		});
	});

	assert.deepEqual(events, [
		['next', {id: 1}],
		['error', 'SyntaxError']
	]);

	let lateError;
	observable.subscribe({error: error => { lateError = error; }});
	assert.equal(lateError.name, 'SyntaxError');
});

test('makes parse failure terminal for simultaneous subscribers', async () => {
	const input = Readable.from(['1\nbad\n2\n']);
	const observable = ndjsonToObservable(input);
	const firstEvents = [];
	const secondEvents = [];
	const terminal = events => new Promise(resolve => {
		observable.subscribe({
			next(value) {
				events.push(['next', value]);
			},
			error(error) {
				events.push(['error', error.name]);
				resolve();
			}
		});
	});

	await Promise.all([terminal(firstEvents), terminal(secondEvents)]);
	assert.deepEqual(firstEvents, [['next', 1], ['error', 'SyntaxError']]);
	assert.deepEqual(secondEvents, firstEvents);
});

test('forwards source stream errors through the observable error channel', async () => {
	const input = new PassThrough();
	const failure = new Error('source failed');
	const result = collect(ndjsonToObservable(input));

	input.write('{"id":1}\n');
	input.destroy(failure);

	await assert.rejects(result, failure);
});

test('contains repeated source errors and retains only the first', async () => {
	const input = new PassThrough();
	const first = new Error('first failure');
	const second = new Error('second failure');
	const result = collect(ndjsonToObservable(input));

	assert.doesNotThrow(() => {
		input.emit('error', first);
		input.emit('error', second);
	});
	await assert.rejects(result, error => error === first);
});

test('retains a source error that occurs before subscription without a process rejection', async () => {
	const input = new PassThrough();
	const failure = new Error('failed before subscription');
	const observable = ndjsonToObservable(input);
	const unhandled = [];
	const onUnhandled = error => unhandled.push(error);
	process.on('unhandledRejection', onUnhandled);

	try {
		assert.doesNotThrow(() => input.emit('error', failure));
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
		await assert.rejects(collect(observable), error => error === failure);
	} finally {
		process.removeListener('unhandledRejection', onUnhandled);
	}
});

test('errors current and late subscribers when the source closes prematurely', async () => {
	const input = new PassThrough();
	const observable = ndjsonToObservable(input);
	const values = [];
	let resolveFirstRecord;
	const firstRecord = new Promise(resolve => { resolveFirstRecord = resolve; });
	const terminal = new Promise((resolve, reject) => {
		observable.subscribe({
			next(value) {
				values.push(value);
				resolveFirstRecord();
			},
			error: resolve,
			complete() {
				reject(new Error('premature close completed'));
			}
		});
	});

	input.write('{"id":1}\n');
	await firstRecord;
	input.write('{"partial":');
	input.destroy();
	const error = await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('premature close hung')), 100))
	]);

	assert.deepEqual(values, [{id: 1}]);
	assert.match(error.message, /closed before ending/i);

	let lateError;
	observable.subscribe({error: received => { lateError = received; }});
	assert.equal(lateError, error);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('retains a premature close that happens before subscription', async () => {
	const input = new PassThrough();
	const observable = ndjsonToObservable(input);
	const closed = new Promise(resolve => input.once('close', resolve));

	input.destroy();
	await closed;
	await assert.rejects(collect(observable), /closed before ending/i);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('does not misclassify normal source end and close as premature', async () => {
	const input = Readable.from(['{"id":1}']);

	assert.deepEqual(await collect(ndjsonToObservable(input)), [{id: 1}]);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('absorbs a delayed source destroy error after observable completion', () => {
	assertProcessFixture('delayed-source-error.js');
});

test('absorbs deferred and arbitrarily late private transform errors', () => {
	assertProcessFixture('late-transform-error.js');
});

test('destroys the source when the final subscriber cancels', async () => {
	const input = new PassThrough();
	const observable = ndjsonToObservable(input);
	const subscription = observable.subscribe();

	assert.equal(input.destroyed, false);
	subscription.unsubscribe();
	assert.equal(input.destroyed, true);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(input.listenerCount('error'), 0);

	let lateCompleted = false;
	observable.subscribe({complete: () => { lateCompleted = true; }});
	assert.equal(lateCompleted, true);
});

test('keeps a shared source alive until the final active subscriber leaves', async () => {
	const input = new PassThrough();
	const observable = ndjsonToObservable(input);
	const firstValues = [];
	const secondValues = [];
	let resolveFirst;
	const firstReceived = new Promise(resolve => { resolveFirst = resolve; });
	const first = observable.subscribe(value => {
		firstValues.push(value);
		resolveFirst();
	});
	const secondComplete = new Promise((resolve, reject) => {
		observable.subscribe({
			next(value) {
				secondValues.push(value);
			},
			error: reject,
			complete: resolve
		});
	});

	input.write('100\n');
	await firstReceived;
	first.unsubscribe();
	assert.equal(input.destroyed, false);
	input.end('2\n');
	await secondComplete;

	assert.deepEqual(firstValues, [100]);
	assert.deepEqual(secondValues, [100, 2]);

	let lateCompleted = false;
	observable.subscribe({complete: () => { lateCompleted = true; }});
	assert.equal(lateCompleted, true);
});
