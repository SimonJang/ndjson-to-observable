'use strict';

const assert = require('assert');
const Readable = require('stream').Readable;
const ndjsonToObservable = require('../lib').ndjsonToObservable;

const input = new Readable({
	read: function () {
		this.push(Buffer.from('\uFEFF{"id":1}\r\nnull\r\n{"id":2}\r\n'));
		this.push(null);
	}
});
const values = [];

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
	}
});
