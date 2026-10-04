'use strict';

const assert = require('node:assert/strict');
const {PassThrough, Readable} = require('node:stream');
const test = require('node:test');
const {ndjsonToObservable} = require('../lib');
const tick = () => new Promise(resolve => setImmediate(resolve));
const destroyAndSettle = async input => {
	const closed = new Promise(resolve => input.once('close', resolve));
	input.destroy();
	await closed;
	await tick();
};
const collect = observable => new Promise((resolve, reject) => {
	const values = [];
	observable.subscribe({next: value => values.push(value), error: reject, complete: () => resolve(values)});
});

test('parses LF-delimited objects and a final record without a newline', async () => {
	assert.deepEqual(await collect(ndjsonToObservable(Readable.from(['{"id":1}\n{"id":2}\n{"id":3}']))),
		[{id: 1}, {id: 2}, {id: 3}]);
});

test('supports BOM, CRLF, surrounding whitespace and blank lines', async () => {
	assert.deepEqual(await collect(ndjsonToObservable(Readable.from(['\uFEFF{"id":1}\r\n\r\n  {"id":2}  \r\n']))),
		[{id: 1}, {id: 2}]);
});

test('completes empty and blank-only input without values', async () => {
	for (const chunks of [[], [' \t\r\n\n']]) {
		assert.deepEqual(await collect(ndjsonToObservable(Readable.from(chunks))), []);
	}
});

test('supports every JSON value, including null before later records', async () => {
	assert.deepEqual(await collect(ndjsonToObservable(Readable.from(['1\ntrue\nnull\n"hello"\n[1,2]\n{"id":3}\n']))),
		[1, true, null, 'hello', [1, 2], {id: 3}]);
});

test('decodes BOM and multibyte characters split across chunks', async () => {
	const bytes = Buffer.from('\uFEFF{"emoji":"😀","id":1}\n{"id":2}\n');
	const chunks = Array.from(bytes, byte => Buffer.from([byte]));
	assert.deepEqual(await collect(ndjsonToObservable(Readable.from(chunks))), [{emoji: '😀', id: 1}, {id: 2}]);
});

test('rejects non-JSON Unicode whitespace and an internal BOM rather than skipping a record', async () => {
	for (const invalid of ['\u00A0', '\uFEFF', '\u2003']) {
		await assert.rejects(collect(ndjsonToObservable(Readable.from([`{"id":1}\n${invalid}\n{"id":2}\n`]))), SyntaxError);
	}
});

test('a malformed record ends parsing before later same-chunk records without destroying the caller input', async () => {
	const input = new PassThrough();
	const values = [];
	let completed = false;
	const failed = new Promise(resolve => ndjsonToObservable(input).subscribe({
		next: value => values.push(value),
		error: resolve,
		complete() { completed = true; }
	}));
	input.write('{"id":1}\ninvalid\nalso-invalid\n{"id":2}\n');
	assert.ok(await failed instanceof SyntaxError);
	assert.deepEqual(values, [{id: 1}]);
	assert.equal(completed, false);
	assert.equal(input.destroyed, false);
	await destroyAndSettle(input);
	assert.equal(input.listenerCount('error'), 0);
});

test('forwards the exact source error once and leaves source destruction to the caller', async () => {
	const input = new PassThrough();
	const error = new Error('source failed');
	const errors = [];
	const failed = new Promise(resolve => ndjsonToObservable(input).subscribe({error(value) { errors.push(value); resolve(); }}));
	input.emit('error', error);
	input.emit('error', new Error('later failure'));
	await failed;
	assert.deepEqual(errors, [error]);
	assert.equal(input.destroyed, false);
	await destroyAndSettle(input);
	assert.equal(input.listenerCount('error'), 0);
});

test('handles source failure before any subscription and retains the error for a late observer', async () => {
	const input = new PassThrough();
	const error = new Error('early failure');
	const observable = ndjsonToObservable(input);
	input.destroy(error);
	await tick();
	await assert.rejects(collect(observable), value => value === error);
});

test('handles parse failure after all observers unsubscribe without an unhandled rejection', async () => {
	const input = new PassThrough();
	const observable = ndjsonToObservable(input);
	observable.subscribe().unsubscribe();
	input.write('invalid\n');
	await tick();
	await tick();
	await assert.rejects(collect(observable), SyntaxError);
	assert.equal(input.destroyed, false);
	input.destroy();
});

test('reports a premature close through the error channel', async () => {
	const input = new PassThrough();
	const done = collect(ndjsonToObservable(input));
	input.destroy();
	await assert.rejects(done, /closed before ending/);
});

test('retains an exact destroy error when legacy close is emitted before the queued error', async () => {
	const input = new PassThrough();
	const error = new Error('destroy failed');
	const done = collect(ndjsonToObservable(input));
	input.emit('close');
	process.nextTick(() => input.emit('error', error));
	await assert.rejects(done, value => value === error);
	input.destroy();
});

test('unsubscribing inside next does not interrupt the other observer', async () => {
	const input = new PassThrough();
	const destroy = input.destroy;
	const privateDestroy = input._destroy;
	const observable = ndjsonToObservable(input);
	const first = [];
	const subscription = observable.subscribe(value => { first.push(value); subscription.unsubscribe(); });
	const second = collect(observable);
	input.end('1\n2\n3\n');
	assert.deepEqual(await second, [1, 2, 3]);
	assert.deepEqual(first, [1]);
	assert.equal(input.destroy, destroy);
	assert.equal(input._destroy, privateDestroy);
});

test('removes source lifecycle listeners after normal completion', async () => {
	const input = new PassThrough();
	const done = collect(ndjsonToObservable(input));
	input.end('{"id":1}\n');
	await done;
	for (const event of ['error', 'end', 'close']) {
		assert.equal(input.listenerCount(event), 0, event);
	}
});
