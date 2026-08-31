'use strict';

const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {Subscriber} = require('rxjs');
const {ndjsonToObservable} = require('../lib');

const input = new PassThrough();
const observable = ndjsonToObservable(input);
const failure = new Error('subscriber failed');
const values = [];
const errors = [];
let verified = false;
let throwing;

const healthy = observable.subscribe({
	next(value) {
		values.push(value);

		if (value === 100) {
			setImmediate(() => {
				assert.deepEqual(values, [100]);
				assert.deepEqual(errors, []);
				assert.equal(input.destroyed, false);
				verified = true;
				throwing.unsubscribe();
				healthy.unsubscribe();
			});
		}
	},
	error(error) {
		errors.push(error);
	}
});
class ThrowingSubscriber extends Subscriber {
	_next() {
		throw failure;
	}
}
throwing = observable.subscribe(new ThrowingSubscriber());

const onUncaughtException = error => {
	assert.equal(error, failure);
};

process.on('uncaughtException', onUncaughtException);
process.on('beforeExit', () => {
	process.removeListener('uncaughtException', onUncaughtException);
	assert.deepEqual(values, [100]);
	assert.deepEqual(errors, []);
	assert.equal(verified, true);
});

input.write('100\n');
