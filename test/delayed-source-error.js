'use strict';

const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const {ndjsonToObservable} = require('../lib');

class DelayedDestroyReadable extends Readable {
	_read() {
		if (this.sent) {
			return;
		}

		this.sent = true;
		this.push('1');
		this.push(null);
	}

	_destroy(error, callback) {
		setTimeout(() => callback(new Error('delayed close failed')), 25);
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

input.once('close', () => {
	setImmediate(() => {
		assert.deepEqual(events, [['next', 1], ['complete']]);
		assert.equal(lateCompleted, true);
		assert.equal(input.listenerCount('error'), 0);
		assert.equal(input.listenerCount('end'), 0);
		assert.equal(input.listenerCount('close'), 0);
	});
});
