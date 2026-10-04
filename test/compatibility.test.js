'use strict';

const assert = require('node:assert/strict');
const {PassThrough, Readable} = require('node:stream');
const test = require('node:test');
const {bufferCount} = require('rxjs/operators');
const current = require('../lib').ndjsonToObservable;
const published = require('ndjson-to-observable-v1').ndjsonToObservable;
const tick = () => new Promise(resolve => setImmediate(resolve));
const collect = observable => new Promise((resolve, reject) => {
	const values = [];
	observable.subscribe({next: value => values.push(value), error: reject, complete: () => resolve(values)});
});

async function eagerReading(adapter) {
	let reads = 0;
	const input = new Readable({read() {
		reads++;
		this.push('{"id":1}\n{"id":2}');
		this.push(null);
	}});
	const observable = adapter(input);
	await tick();
	const readsBeforeSubscription = reads;
	await collect(observable);
	return readsBeforeSubscription;
}

async function unsubscribeAndResume(adapter) {
	const input = new PassThrough();
	const observable = adapter(input);
	const first = [];
	let observed;
	const firstValue = new Promise(resolve => { observed = resolve; });
	const subscription = observable.subscribe(value => { first.push(value); observed(); });
	input.write('{"id":1}\n{"id":2}');
	await firstValue;
	subscription.unsubscribe();
	const destroyedAfterUnsubscribe = input.destroyed;
	const resumed = collect(observable);
	input.end('\n{"id":3}');
	return {first, destroyedAfterUnsubscribe, resumed: await resumed};
}

async function sharing(adapter) {
	const input = new PassThrough();
	const observable = adapter(input);
	const a = [];
	const b = [];
	const c = [];
	let observed;
	const firstValue = new Promise(resolve => { observed = resolve; });
	const first = observable.subscribe(value => { a.push(value); observed(); });
	const second = observable.subscribe(value => b.push(value));
	input.write('{"id":1}\n{"id":2}');
	await firstValue;
	second.unsubscribe();
	const third = observable.subscribe(value => c.push(value));
	const done = collect(observable);
	input.end('\n{"id":3}');
	await done;
	first.unsubscribe();
	third.unsubscribe();
	return {a, b, c};
}

async function delayedFirstSubscription(adapter) {
	const input = new PassThrough();
	const observable = adapter(input);
	input.write('{"id":1}\n{"id":2}');
	// Allow the BOM transform's asynchronous chunk forwarding to finish while
	// there are no subscribers, but leave the source open for future records.
	for (let turn = 0; turn < 10; turn++) { await tick(); }
	const later = collect(observable);
	input.end('\n{"id":3}');
	return later;
}

async function zeroSubscriberGap(adapter) {
	const input = new PassThrough();
	const observable = adapter(input);
	let observed;
	const ready = new Promise(resolve => { observed = resolve; });
	const first = observable.subscribe(() => observed());
	input.write('{"id":1}\n{"id":2}');
	await ready;
	first.unsubscribe();
	input.write('\n{"id":3}');
	for (let turn = 0; turn < 10; turn++) { await tick(); }
	const later = collect(observable);
	input.end('\n{"id":4}');
	return later;
}

async function lateTerminal(adapter, invalid) {
	const observable = adapter(Readable.from([invalid ? 'invalid' : '{"id":1}']));
	await collect(observable).catch(() => undefined);
	const order = ['before'];
	const done = new Promise(resolve => observable.subscribe({
		error(error) { order.push(error.name); resolve(); },
		complete() { order.push('complete'); resolve(); }
	}));
	order.push('after');
	await done;
	return order;
}

for (const [name, scenario, expected] of [
	['starts reading before the first subscription', eagerReading, 1],
	['keeps the input alive after the final unsubscribe and permits resubscription', unsubscribeAndResume,
		{first: [{id: 1}], destroyedAfterUnsubscribe: false, resumed: [{id: 2}, {id: 3}]}],
	['shares the stream between observers without replaying earlier values', sharing,
		{a: [{id: 1}, {id: 2}, {id: 3}], b: [{id: 1}], c: [{id: 2}, {id: 3}]}],
	['preserves delivery after a delayed first subscription', delayedFirstSubscription, [{id: 2}, {id: 3}]],
	['preserves delivery across a gap with no subscribers', zeroSubscriberGap, [{id: 3}, {id: 4}]],
	['delivers late completion asynchronously', adapter => lateTerminal(adapter, false), ['before', 'after', 'complete']],
	['delivers late errors asynchronously', adapter => lateTerminal(adapter, true), ['before', 'after', 'SyntaxError']]
]) {
	test(`matches published 1.1.0: ${name}`, async () => {
		const baseline = await scenario(published);
		assert.deepEqual(baseline, expected);
		assert.deepEqual(await scenario(current), baseline);
	});
}

test('preserves the published bufferCount/toPromise consumer example', async () => {
	const records = [{firstName: 'Bob', name: 'Smith'}, {firstName: 'Alice', name: 'Williams'}, {firstName: 'Malcolm', name: 'John'}];
	for (const adapter of [published, current]) {
		const input = Readable.from([records.map(record => JSON.stringify(record)).join('\n')]);
		assert.deepEqual(await adapter(input).pipe(bufferCount(4)).toPromise(), records);
	}
});
