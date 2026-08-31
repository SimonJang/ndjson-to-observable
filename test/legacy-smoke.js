'use strict';

const assert = require('assert');
const PassThrough = require('stream').PassThrough;
const Readable = require('stream').Readable;
const inherits = require('util').inherits;
const ndjsonToObservable = require('../lib').ndjsonToObservable;

const input = new Readable({
	read: function () {
		this.push(Buffer.from('\uFEFF{"id":1}\r\nnull\r\n{"id":2}\r\n'));
		this.push(null);
	}
});
const values = [];
let completed = false;
let sourceErrorObserved = false;
let pendingSourceErrorObserved = false;
let prematureCloseObserved = false;
let prematureCloseCompleted = false;
let prematureCloseError;
let activePrematureCloseObserved = false;
let activePrematureCloseCompleted = false;
let quietDestroyObserved = false;
let preconstructionQuietDestroyObserved = false;
let lockedDelayedDestroyObserved = false;
let lateCustomDestroyObserved = false;
let lateExternalDestroyObserved = false;

process.on('beforeExit', function () {
	assert.strictEqual(completed, true, 'observable did not complete');
	assert.strictEqual(sourceErrorObserved, true, 'source error was not observed');
	assert.strictEqual(pendingSourceErrorObserved, true, 'pending source error was not observed');
	assert.strictEqual(prematureCloseObserved, true, 'errorless premature close was not observed');
	assert.strictEqual(prematureCloseCompleted, false, 'errorless premature close completed the observable');
	assert.strictEqual(activePrematureCloseObserved, true, 'active errorless premature close was not observed');
	assert.strictEqual(activePrematureCloseCompleted, false, 'active errorless premature close completed the observable');
	assert.strictEqual(quietDestroyObserved, true, 'quiet destroy was not observed');
	assert.strictEqual(preconstructionQuietDestroyObserved, true, 'preconstruction quiet destroy was not observed');
	assert.strictEqual(lockedDelayedDestroyObserved, true, 'locked delayed destroy error was not observed');
	assert.strictEqual(lateCustomDestroyObserved, true, 'late custom destroy error escaped its guard');
	assert.strictEqual(lateExternalDestroyObserved, true, 'late custom destroy error did not reach external listener');
	assert.strictEqual(input.listenerCount('error'), 0, 'completed input retained an error listener');
	assert.strictEqual(input.listenerCount('end'), 0, 'completed input retained an end listener');
	assert.strictEqual(input.listenerCount('close'), 0, 'completed input retained a close listener');
});

ndjsonToObservable(input).subscribe({
	next: function (value) {
		values.push(value);
	},
	error: function (error) {
		console.error(error);
		process.exitCode = 1;
	},
	complete: function () {
		assert.deepStrictEqual(values, [{id: 1}, null, {id: 2}]);
		completed = true;
	}
});

const failedInput = new PassThrough();
const sourceError = new Error('source failed');

failedInput.on('error', function () {});

ndjsonToObservable(failedInput).subscribe({
	error: function (error) {
		assert.strictEqual(error, sourceError);
		sourceErrorObserved = true;
	},
	complete: function () {
		assert.fail('source failure completed the observable');
	}
});

failedInput.destroy(sourceError);

const pendingInput = new PassThrough();
const pendingSourceError = new Error('source failed before subscription');
const pendingObservable = ndjsonToObservable(pendingInput);

pendingInput.once('error', function () {});
pendingInput.destroy(pendingSourceError);

setImmediate(function () {
	pendingObservable.subscribe({
		error: function (error) {
			assert.strictEqual(error, pendingSourceError);
			pendingSourceErrorObserved = true;
		},
		complete: function () {
			assert.fail('pending source failure completed the observable');
		}
	});
});

const prematureInput = new PassThrough();

prematureInput.destroy();
const prematureObservable = ndjsonToObservable(prematureInput);

prematureObservable.subscribe({
	error: function (error) {
		prematureCloseError = error;
		prematureCloseObserved = true;
		assert.ok(/closed before ending/i.test(error.message));
	},
	complete: function () {
		prematureCloseCompleted = true;
	}
});

setImmediate(function () {
	let lateError;

	prematureObservable.subscribe({
		error: function (error) {
			lateError = error;
		}
	});
	assert.strictEqual(lateError, prematureCloseError);
});

const activePrematureInput = new PassThrough();
const activePrematureValues = [];

ndjsonToObservable(activePrematureInput).subscribe({
	next: function (value) {
		activePrematureValues.push(value);
		activePrematureInput.destroy();
	},
	error: function (error) {
		assert.ok(/closed before ending/i.test(error.message));
		assert.deepStrictEqual(activePrematureValues, [100]);
		activePrematureCloseObserved = true;
	},
	complete: function () {
		activePrematureCloseCompleted = true;
	}
});

activePrematureInput.write('100\n2');

function QuietDestroyReadable() {
	Readable.call(this);
}

inherits(QuietDestroyReadable, Readable);
QuietDestroyReadable.prototype._read = function () {};
QuietDestroyReadable.prototype._destroy = function (error, callback) {
	callback(error);
};

const quietInput = new QuietDestroyReadable();

ndjsonToObservable(quietInput).subscribe({
	error: function (error) {
		assert.ok(/closed before ending/i.test(error.message));
		setImmediate(function () {
			assert.strictEqual(quietInput.listenerCount('error'), 0);
			assert.strictEqual(quietInput.listenerCount('end'), 0);
			assert.strictEqual(quietInput.listenerCount('close'), 0);
			quietDestroyObserved = true;
		});
	},
	complete: function () {
		assert.fail('quiet destroy completed the observable');
	}
});

quietInput.destroy();

const preconstructionQuietInput = new QuietDestroyReadable();

preconstructionQuietInput.destroy();
ndjsonToObservable(preconstructionQuietInput).subscribe({
	error: function (error) {
		assert.ok(/closed before ending/i.test(error.message));
		preconstructionQuietDestroyObserved = true;
	},
	complete: function () {
		assert.fail('preconstruction quiet destroy completed the observable');
	}
});

const lockedDelayedFailure = new Error('locked delayed destroy failed');
const lockedDelayedInput = new Readable({read: function () {}});

Object.defineProperty(lockedDelayedInput, '_destroy', {
	configurable: false,
	value: function (error, callback) {
		setTimeout(function () {
			callback(lockedDelayedFailure);
		}, 500);
	},
	writable: false
});

ndjsonToObservable(lockedDelayedInput).subscribe({
	error: function (error) {
		assert.strictEqual(error, lockedDelayedFailure);
		setImmediate(function () {
			assert.strictEqual(lockedDelayedInput.listenerCount('error'), 0);
			assert.strictEqual(lockedDelayedInput.listenerCount('end'), 0);
			assert.strictEqual(lockedDelayedInput.listenerCount('close'), 0);
			lockedDelayedDestroyObserved = true;
		});
	},
	complete: function () {
		assert.fail('locked delayed destroy completed the observable');
	}
});

lockedDelayedInput.destroy();

const lateCustomFailure = new Error('late custom public destroy failed');
const lateCustomInput = new Readable({read: function () {}});
const standardDestroy = lateCustomInput.destroy;
let lateCustomTerminalError;

Object.defineProperty(lateCustomInput, '_destroy', {
	configurable: false,
	value: function (error, callback) {
		setTimeout(function () {
			callback(lateCustomFailure);
		}, 100);
	},
	writable: false
});
lateCustomInput.destroy = function (error, callback) {
	return standardDestroy.call(this, error, callback);
};

ndjsonToObservable(lateCustomInput).subscribe({
	error: function (error) {
		lateCustomTerminalError = error;
	},
	complete: function () {
		assert.fail('late custom destroy completed the observable');
	}
});

lateCustomInput.destroy();

setTimeout(function () {
	assert.ok(/closed before ending/i.test(lateCustomTerminalError.message));
	assert.strictEqual(lateCustomInput.listenerCount('error'), 0);
	assert.strictEqual(lateCustomInput.listenerCount('end'), 0);
	assert.strictEqual(lateCustomInput.listenerCount('close'), 0);
	lateCustomDestroyObserved = true;
}, 150);

const lateExternalFailure = new Error('late external destroy failed');
const lateExternalInput = new Readable({read: function () {}});
const lateExternalStandardDestroy = lateExternalInput.destroy;
let lateExternalSourceError;
let lateExternalTerminalError;

Object.defineProperty(lateExternalInput, '_destroy', {
	configurable: false,
	value: function (error, callback) {
		setTimeout(function () {
			callback(lateExternalFailure);
		}, 100);
	},
	writable: false
});
lateExternalInput.destroy = function (error, callback) {
	return lateExternalStandardDestroy.call(this, error, callback);
};
lateExternalInput.once('error', function (error) {
	lateExternalSourceError = error;
});

ndjsonToObservable(lateExternalInput).subscribe({
	error: function (error) {
		lateExternalTerminalError = error;
	},
	complete: function () {
		assert.fail('late external destroy completed the observable');
	}
});

lateExternalInput.destroy();

setTimeout(function () {
	assert.ok(/closed before ending/i.test(lateExternalTerminalError.message));
	assert.strictEqual(lateExternalSourceError, lateExternalFailure);
	assert.strictEqual(lateExternalInput.listenerCount('error'), 0);
	assert.strictEqual(lateExternalInput.listenerCount('end'), 0);
	assert.strictEqual(lateExternalInput.listenerCount('close'), 0);
	lateExternalDestroyObserved = true;
}, 150);
