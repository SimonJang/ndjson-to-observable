'use strict';

const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const {ndjsonToObservable} = require('../lib');

let verified = false;

class DelayedDestroyReadable extends Readable {
	constructor() {
		super({emitClose: false});
	}

	_read() {
		if (this.sent) {
			return;
		}

		this.sent = true;
		this.push('1');
		this.push(null);
	}

	_destroy(error, callback) {
		setTimeout(() => {
			callback(new Error('delayed close failed'));
			setImmediate(() => {
				assert.equal(input.closed, true);
				assert.equal(input.listenerCount('error'), 0);
				assert.equal(input.listenerCount('end'), 0);
				assert.equal(input.listenerCount('close'), 0);
				verified = true;
			});
		}, 25);
	}
}

const input = new DelayedDestroyReadable();
const observable = ndjsonToObservable(input);
const events = [];
let lateCompleted = false;

observable.subscribe({
	next(value) {
		events.push(['next', value]);
	},
	error(error) {
		events.push(['error', error.message]);
	},
	complete() {
		events.push(['complete']);
		observable.subscribe({complete: () => { lateCompleted = true; }});
	}
});

process.on('beforeExit', () => {
	assert.deepEqual(events, [['next', 1], ['complete']]);
	assert.equal(lateCompleted, true);
	assert.equal(verified, true);
});
