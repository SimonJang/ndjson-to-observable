'use strict';

const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');

const stripBOMPath = require.resolve('strip-bom-stream');
const libraryPath = require.resolve('../lib');
const createStripBOM = require(stripBOMPath);
const transforms = [];

require.cache[stripBOMPath].exports = (...args) => {
	const transform = createStripBOM(...args);
	transforms.push(transform);
	return transform;
};
delete require.cache[libraryPath];

const {ndjsonToObservable} = require('../lib');
const waitForDeferredErrors = () => new Promise(resolve => setTimeout(resolve, 50));

const run = async () => {
	const activeInput = new PassThrough();
	const activeObservable = ndjsonToObservable(activeInput);
	const activeFailure = new Error('BOM transform failed');
	const observerErrors = [];

	activeObservable.subscribe({error: error => observerErrors.push(error)});
	transforms[0].emit('error', activeFailure);
	await waitForDeferredErrors();
	assert.deepEqual(observerErrors, [activeFailure]);

	let lateError;
	activeObservable.subscribe({error: error => { lateError = error; }});
	assert.equal(lateError, activeFailure);
	transforms[0].emit('error', new Error('arbitrarily late active error'));
	await waitForDeferredErrors();

	const cancelledInput = new PassThrough();
	const cancelledObservable = ndjsonToObservable(cancelledInput);
	const subscription = cancelledObservable.subscribe();
	const cancelledTransform = transforms[1];
	const originalDestroy = cancelledTransform.destroy.bind(cancelledTransform);
	cancelledTransform.destroy = () => {
		cancelledTransform.emit('error', new Error('destroy-time transform error'));
		return originalDestroy();
	};

	subscription.unsubscribe();
	await waitForDeferredErrors();
	let lateCompleted = false;
	cancelledObservable.subscribe({complete: () => { lateCompleted = true; }});
	assert.equal(lateCompleted, true);
	cancelledTransform.emit('error', new Error('arbitrarily late cancelled error'));
	await waitForDeferredErrors();
};

run().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
