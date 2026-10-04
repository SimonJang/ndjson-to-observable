'use strict';

const assert = require('assert');
const PassThrough = require('stream').PassThrough;
const Readable = require('stream').Readable;
const ndjsonToObservable = require('../lib').ndjsonToObservable;
const collect = observable => new Promise((resolve, reject) => {
	const values = [];
	observable.subscribe({next: value => values.push(value), error: reject, complete: () => resolve(values)});
});
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
	const input = new Readable({read() {
		this.push(Buffer.from('\uFEFF{"id":1}\r\nnull\r\n{"id":2}\r\n'));
		this.push(null);
	}});
	assert.deepStrictEqual(await collect(ndjsonToObservable(input)), [{id: 1}, null, {id: 2}]);

	let reads = 0;
	const eagerInput = new Readable({read() { reads++; this.push('{"id":1}'); this.push(null); }});
	const eager = ndjsonToObservable(eagerInput);
	await tick();
	assert.strictEqual(reads, 1, 'construction must start reading before subscription');
	await collect(eager);

	const ownedInput = new PassThrough();
	const destroy = ownedInput.destroy;
	const observable = ndjsonToObservable(ownedInput);
	observable.subscribe().unsubscribe();
	assert.strictEqual(ownedInput.destroyed, false, 'unsubscribe must not destroy the caller input');
	assert.strictEqual(ownedInput.destroy, destroy, 'the adapter must not wrap source destroy');
	const resumed = collect(observable);
	ownedInput.end('{"id":2}\n');
	assert.deepStrictEqual(await resumed, [{id: 2}]);
	let synchronous = true;
	const lateCompletion = new Promise(resolve => observable.subscribe({complete() { assert.strictEqual(synchronous, false); resolve(); }}));
	synchronous = false;
	await lateCompletion;

	const failedInput = new PassThrough();
	const error = new Error('source failed');
	const failedObservable = ndjsonToObservable(failedInput);
	failedInput.destroy(error);
	await tick();
	let observedError;
	await collect(failedObservable).catch(value => { observedError = value; });
	assert.strictEqual(observedError, error);

	const malformedInput = new PassThrough();
	const malformed = ndjsonToObservable(malformedInput);
	malformed.subscribe().unsubscribe();
	malformedInput.write('invalid\n{"id":3}\n');
	await tick();
	await tick();
	let malformedError;
	await collect(malformed).catch(value => { malformedError = value; });
	assert.ok(malformedError instanceof SyntaxError);
	assert.strictEqual(malformedInput.destroyed, false);
	malformedInput.destroy();
	const unicodeInput = new PassThrough();
	const unicodeDone = collect(ndjsonToObservable(unicodeInput));
	unicodeInput.end('1\n\u00A0\n2\n');
	let unicodeError;
	await unicodeDone.catch(value => { unicodeError = value; });
	assert.ok(unicodeError instanceof SyntaxError);
	console.log('Node 8 compatibility smoke passed');
}

let finished = false;
main().then(() => { finished = true; }, error => { console.error(error); process.exitCode = 1; });
process.on('beforeExit', () => { assert.strictEqual(finished, true, 'smoke test did not finish'); });
