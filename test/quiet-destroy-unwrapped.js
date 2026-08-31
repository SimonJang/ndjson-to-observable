'use strict';

const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const {ndjsonToObservable} = require('../lib');

const input = new Readable({
	emitClose: false,
	read() {}
});
let observedError;

Object.defineProperty(input, '_destroy', {
	configurable: false,
	value: input._destroy,
	writable: false
});

ndjsonToObservable(input).subscribe({
	error(error) {
		observedError = error;
	}
});

input.destroy();

process.on('beforeExit', () => {
	assert.match(observedError.message, /closed before ending/i);
	assert.equal(input.listenerCount('error'), 0);
	assert.equal(input.listenerCount('end'), 0);
	assert.equal(input.listenerCount('close'), 0);
});
