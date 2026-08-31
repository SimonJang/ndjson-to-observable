'use strict';

const assert = require('assert');
const PassThrough = require('stream').PassThrough;
const Readable = require('stream').Readable;
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

process.on('beforeExit', function () {
	assert.strictEqual(completed, true, 'observable did not complete');
	assert.strictEqual(sourceErrorObserved, true, 'source error was not observed');
	assert.strictEqual(pendingSourceErrorObserved, true, 'pending source error was not observed');
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
