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
		encoding: 'utf8',
		timeout: 2000
	});

	assert.equal(result.status, 0, [
		result.stdout,
		result.stderr,
		result.error && result.error.stack,
		result.signal
	].filter(Boolean).join('\n'));
};

test('does not read the source before the first subscription', async () => {
	let reads = 0;
	const input = new Readable({
		read() {
			reads++;
			this.push('{"id":1}\n');
			this.push(null);
		}
	});
	const observable = ndjsonToObservable(input);

	await new Promise(resolve => setImmediate(resolve));
	assert.equal(reads, 0);
	assert.deepEqual(await collect(observable), [{id: 1}]);
	assert.equal(reads, 1);
});

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

test('completes empty and blank-only sources without values', async () => {
	assert.deepEqual(await collect(ndjsonToObservable(Readable.from([]))), []);
	assert.deepEqual(await collect(ndjsonToObservable(Readable.from([' \t\r\n\n']))), []);
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
	const privateTransforms = [];
	const destroyedStreams = new Set();
	const trackDestroy = stream => {
		const destroy = stream.destroy;
		stream.destroy = function () {
			destroyedStreams.add(stream);
			return destroy.apply(this, arguments);
		};
	};
	trackDestroy(input);
	const sourcePipe = input.pipe;
	input.pipe = function (destination) {
		privateTransforms.push(destination);
		trackDestroy(destination);
		const transformPipe = destination.pipe;
		destination.pipe = function (next) {
			privateTransforms.push(next);
			trackDestroy(next);
			return transformPipe.apply(this, arguments);
		};
		return sourcePipe.apply(this, arguments);
	};
	const observable = ndjsonToObservable(input);
	const events = [];
	let firstError;
	let destroyedAtError;

	await new Promise(resolve => {
		observable.subscribe({
			next(value) {
				events.push(['next', value]);
			},
			error(error) {
				firstError = error;
				destroyedAtError = [input, ...privateTransforms].map(stream => destroyedStreams.has(stream));
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
	assert.equal(privateTransforms.length, 2);
	assert.deepEqual(destroyedAtError, [true, true, true]);
	assert.doesNotThrow(() => {
		for (const transform of privateTransforms) {
			transform.emit('error', new Error('late transform failure'));
		}
	});

	let lateError;
	observable.subscribe({error: error => { lateError = error; }});
	assert.equal(lateError, firstError);
});

test('rejects non-JSON Unicode whitespace as a malformed record', async () => {
	const input = Readable.from(['1\n\uFEFF\n2\n']);
	const values = [];
	const terminal = new Promise((resolve, reject) => {
		ndjsonToObservable(input).subscribe({
			next(value) {
				values.push(value);
			},
			error: reject,
			complete: resolve
		});
	});

	await assert.rejects(terminal, error => error instanceof SyntaxError);
	assert.deepEqual(values, [1]);
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

test('does not treat a synchronous subscriber exception as an adapter failure', () => {
	assertProcessFixture('subscriber-error.js');
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

test('retains a pending source error when destroyed before construction', async () => {
	const input = new PassThrough();
	const failure = new Error('failed before construction');

	input.once('error', () => {});
	input.destroy(failure);
	const observable = ndjsonToObservable(input);

	await assert.rejects(collect(observable), error => error === failure);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('retains a pending destroy error before the first subscription', async () => {
	const input = new PassThrough();
	const failure = new Error('failed before first subscription');
	const observable = ndjsonToObservable(input);

	input.once('error', () => {});
	input.destroy(failure);
	await new Promise(resolve => setImmediate(resolve));

	await assert.rejects(collect(observable), error => error === failure);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('retains a delayed destroy error that started before construction', async () => {
	const failure = new Error('delayed destroy failed');
	class DelayedDestroyReadable extends Readable {
		_read() {}

		_destroy(error, callback) {
			setTimeout(() => callback(failure), 25);
		}
	}
	const input = new DelayedDestroyReadable();

	input.destroy();
	const observable = ndjsonToObservable(input);

	await assert.rejects(collect(observable), error => error === failure);

	let lateError;
	observable.subscribe({error: error => { lateError = error; }});
	assert.equal(lateError, failure);
});

test('source error beats reentrant final cancellation', async () => {
	const input = new PassThrough();
	const failure = new Error('source failed');
	let subscription;

	input.once('error', () => subscription.unsubscribe());
	const observable = ndjsonToObservable(input);
	subscription = observable.subscribe({error() {}});
	input.destroy(failure);
	await new Promise(resolve => setImmediate(resolve));

	let lateError;
	observable.subscribe({error: error => { lateError = error; }});
	assert.equal(lateError, failure);
});

test('premature close beats reentrant final cancellation', async () => {
	const input = new PassThrough();
	let subscription;

	input.once('close', () => subscription.unsubscribe());
	const observable = ndjsonToObservable(input);
	subscription = observable.subscribe({error() {}});
	input.destroy();

	const lateError = await new Promise((resolve, reject) => {
		observable.subscribe({
			error: resolve,
			complete: () => reject(new Error('premature close completed'))
		});
	});
	assert.match(lateError.message, /closed before ending/i);
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
	await new Promise(resolve => setImmediate(resolve));
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

test('retains a premature close that happened before observable construction', async () => {
	const input = new PassThrough();
	const closed = new Promise(resolve => input.once('close', resolve));

	input.destroy();
	await closed;

	const observable = ndjsonToObservable(input);
	await assert.rejects(collect(observable), /closed before ending/i);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('does not treat destroy-produced EOF as successful completion', async () => {
	class EofOnDestroyReadable extends Readable {
		_read() {}

		_destroy(error, callback) {
			this.push(null);
			process.nextTick(callback, error);
		}
	}

	const input = new EofOnDestroyReadable();

	input.destroy();
	const observable = ndjsonToObservable(input);

	await assert.rejects(collect(observable), /closed before ending/i);

	let lateError;
	observable.subscribe({error: error => { lateError = error; }});
	assert.match(lateError.message, /closed before ending/i);
});

test('does not emit buffered records after premature termination starts', async () => {
	class EofOnDestroyReadable extends Readable {
		_read() {}

		_destroy(error, callback) {
			this.push(null);
			process.nextTick(callback, error);
		}
	}
	const input = new EofOnDestroyReadable();
	const observable = ndjsonToObservable(input);
	const values = [];
	const terminal = new Promise((resolve, reject) => {
		observable.subscribe({
			next(value) {
				values.push(value);
				input.destroy();
			},
			error: resolve,
			complete: () => reject(new Error('premature termination completed'))
		});
	});

	input.push('100\n2');
	await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('premature termination hung')), 100))
	]);

	assert.deepEqual(values, [100]);
});

test('does not emit buffered records after destroy with an error starts', async () => {
	const input = new PassThrough();
	const failure = new Error('source failed');
	const values = [];
	const terminal = new Promise((resolve, reject) => {
		ndjsonToObservable(input).subscribe({
			next(value) {
				values.push(value);
				input.destroy(failure);
			},
			error: resolve,
			complete: () => reject(new Error('source error completed'))
		});
	});

	input.write('100\n2\n3\n');
	const error = await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('source error hung')), 100))
	]);

	assert.equal(error, failure);
	assert.deepEqual(values, [100]);
});

test('errors when an active source is quietly destroyed before EOF', async () => {
	const input = new Readable({
		emitClose: false,
		read() {}
	});
	const observable = ndjsonToObservable(input);
	const terminal = new Promise((resolve, reject) => {
		observable.subscribe({
			error: resolve,
			complete: () => reject(new Error('quiet destroy completed'))
		});
	});

	input.destroy();
	const error = await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('quiet destroy hung')), 100))
	]);

	assert.match(error.message, /closed before ending/i);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('detects quiet destruction when the source destroy hook cannot be wrapped', () => {
	assertProcessFixture('quiet-destroy-unwrapped.js');
});

test('detects quiet destruction when public destroy cannot be wrapped', () => {
	assertProcessFixture('quiet-destroy-unwrapped-public.js');
});

test('detects quiet destruction when neither destroy hook can be wrapped', () => {
	assertProcessFixture('quiet-destroy-unwrapped-both.js');
});

test('detects quiet destruction after public destroy is replaced', async () => {
	const input = new Readable({
		emitClose: false,
		read() {}
	});
	const originalDestroy = input.destroy;

	Object.defineProperty(input, '_destroy', {
		configurable: false,
		value: input._destroy,
		writable: false
	});
	const observable = ndjsonToObservable(input);

	input.destroy = function (error, ignoredCallback) {
		void ignoredCallback;
		return originalDestroy.call(this, error);
	};

	const terminal = new Promise((resolve, reject) => {
		observable.subscribe({
			error: resolve,
			complete: () => reject(new Error('quiet destroy completed'))
		});
	});

	input.destroy();
	const error = await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('quiet destroy hung')), 100))
	]);

	assert.match(error.message, /closed before ending/i);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('detects quiet destruction when a public destroy override ignores its callback', async () => {
	const input = new Readable({
		emitClose: false,
		read() {}
	});
	const originalDestroy = input.destroy;

	Object.defineProperty(input, '_destroy', {
		configurable: false,
		value: input._destroy,
		writable: false
	});
	input.destroy = function (error, ignoredCallback) {
		void ignoredCallback;
		return originalDestroy.call(this, error);
	};

	const observable = ndjsonToObservable(input);
	const terminal = new Promise((resolve, reject) => {
		observable.subscribe({
			error: resolve,
			complete: () => reject(new Error('quiet destroy completed'))
		});
	});

	input.destroy();
	const error = await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('quiet destroy hung')), 100))
	]);

	assert.match(error.message, /closed before ending/i);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('detects quiet destruction after the source destroy hook is replaced', async () => {
	const input = new Readable({
		emitClose: false,
		read() {}
	});
	const observable = ndjsonToObservable(input);

	input._destroy = function (error, callback) {
		callback(error);
	};

	const terminal = new Promise((resolve, reject) => {
		observable.subscribe({
			error: resolve,
			complete: () => reject(new Error('quiet destroy completed'))
		});
	});

	input.destroy();
	const error = await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('quiet destroy hung')), 100))
	]);

	assert.match(error.message, /closed before ending/i);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('detects quiet destruction after both destroy hooks are replaced', async () => {
	const input = new Readable({
		emitClose: false,
		read() {}
	});
	const originalDestroy = input.destroy;
	const originalInternalDestroy = input._destroy;
	const observable = ndjsonToObservable(input);

	input.destroy = function (error) {
		return originalDestroy.call(this, error);
	};
	input._destroy = function (error, callback) {
		return originalInternalDestroy.call(this, error, callback);
	};

	const terminal = new Promise((resolve, reject) => {
		observable.subscribe({
			error: resolve,
			complete: () => reject(new Error('quiet destroy completed'))
		});
	});

	input.destroy();
	const error = await Promise.race([
		terminal,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('quiet destroy hung')), 100))
	]);

	assert.match(error.message, /closed before ending/i);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('does not retain listeners when the source ended and closed before construction', async () => {
	const input = Readable.from(['{"id":1}']);
	await new Promise((resolve, reject) => {
		const onError = error => {
			input.removeListener('close', onClose);
			reject(error);
		};
		const onClose = () => {
			input.removeListener('error', onError);
			resolve();
		};

		input.once('error', onError);
		input.once('close', onClose);
		input.resume();
	});

	assert.deepEqual(await collect(ndjsonToObservable(input)), []);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('does not retain listeners when an already-ended source is never subscribed', async () => {
	const input = Readable.from(['1']);
	await new Promise((resolve, reject) => {
		const onClose = () => {
			input.removeListener('error', reject);
			resolve();
		};

		input.once('error', reject);
		input.once('close', onClose);
		input.resume();
	});

	const observable = ndjsonToObservable(input);

	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);

	let lateCompleted = false;
	observable.subscribe({complete: () => { lateCompleted = true; }});
	assert.equal(lateCompleted, true);
});

test('retains completion when a source ends before the first subscription', async () => {
	const input = Readable.from(['1']);
	const observable = ndjsonToObservable(input);

	await new Promise((resolve, reject) => {
		const onClose = () => {
			input.removeListener('error', reject);
			resolve();
		};

		input.once('error', reject);
		input.once('close', onClose);
		input.resume();
	});

	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);

	let lateCompleted = false;
	observable.subscribe({complete: () => { lateCompleted = true; }});
	assert.equal(lateCompleted, true);
});

test('restores source lifecycle hooks after two adapters complete', async () => {
	const input = new Readable({
		autoDestroy: false,
		read() {}
	});
	const hadOwnDestroy = Object.prototype.hasOwnProperty.call(input, 'destroy');
	const hadOwnInternalDestroy = Object.prototype.hasOwnProperty.call(input, '_destroy');
	const originalDestroy = input.destroy;
	const originalInternalDestroy = input._destroy;
	const first = collect(ndjsonToObservable(input));
	const second = collect(ndjsonToObservable(input));

	input.push('1\n');
	input.push(null);

	assert.deepEqual(await first, [1]);
	assert.deepEqual(await second, [1]);
	assert.equal(input.destroy, originalDestroy);
	assert.equal(input._destroy, originalInternalDestroy);
	assert.equal(Object.prototype.hasOwnProperty.call(input, 'destroy'), hadOwnDestroy);
	assert.equal(Object.prototype.hasOwnProperty.call(input, '_destroy'), hadOwnInternalDestroy);
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

test('removes source listeners after successful end without close', async () => {
	const input = new Readable({
		autoDestroy: false,
		read() {
			this.push('1\n');
			this.push(null);
		}
	});

	assert.deepEqual(await collect(ndjsonToObservable(input)), [1]);
	assert.equal(input.destroyed, false);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('removes source listeners after successful auto-destroy without close', async () => {
	const input = new Readable({
		autoDestroy: true,
		emitClose: false,
		read() {
			this.push('1\n');
			this.push(null);
		}
	});

	assert.deepEqual(await collect(ndjsonToObservable(input)), [1]);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(input.destroyed, true);
	assert.equal(input.closed, true);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});

test('absorbs a delayed source destroy error after observable completion', () => {
	assertProcessFixture('delayed-source-error.js');
});

test('absorbs a delayed destroy error when close events are disabled', () => {
	assertProcessFixture('delayed-source-error-no-close.js');
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

test('removes source listeners after final cancellation without close', async () => {
	const input = new Readable({
		emitClose: false,
		read() {}
	});
	const observable = ndjsonToObservable(input);
	const subscription = observable.subscribe();

	subscription.unsubscribe();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(input.destroyed, true);
	assert.equal(input.closed, true);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);

	let lateCompleted = false;
	observable.subscribe({complete: () => { lateCompleted = true; }});
	assert.equal(lateCompleted, true);
});

test('removes source listeners after final cancellation with an unwrappable destroy hook', async () => {
	const input = new Readable({
		emitClose: false,
		read() {}
	});

	Object.defineProperty(input, '_destroy', {
		configurable: false,
		value: input._destroy,
		writable: false
	});

	const observable = ndjsonToObservable(input);
	const subscription = observable.subscribe();

	subscription.unsubscribe();
	await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);

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

test('does not replay earlier values to subscribers that join an active stream', async () => {
	const input = new PassThrough();
	const observable = ndjsonToObservable(input);
	const firstValues = [];
	const secondValues = [];
	let resolveFirstValue;
	const firstValue = new Promise(resolve => { resolveFirstValue = resolve; });
	const first = observable.subscribe(value => {
		firstValues.push(value);
		resolveFirstValue();
	});

	input.write('100\n');
	await Promise.race([
		firstValue,
		new Promise((resolve, reject) => setTimeout(() => reject(new Error('first value hung')), 100))
	]);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(firstValues, [100]);

	const secondComplete = new Promise((resolve, reject) => {
		observable.subscribe({
			next(value) {
				secondValues.push(value);
			},
			error: reject,
			complete: resolve
		});
	});

	input.write('2\n');
	input.end();
	await secondComplete;
	first.unsubscribe();

	assert.deepEqual(firstValues, [100, 2]);
	assert.deepEqual(secondValues, [2]);
});
