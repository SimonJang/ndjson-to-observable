import { join } from 'path';
import * as fs from 'fs';
import test from 'ava';
import { tap, bufferCount } from 'rxjs/operators';
import { ndjsonToObservable } from '../index';

const data = [
	{
		firstName: 'Bob',
		name: 'Smith'
	},
	{
		firstName: 'Alice',
		name: 'Williams'
	},
	{
		firstName: 'Malcolm',
		name: 'John'
	}
]

test('should create an observable stream', async t => {
	const ndjsonStream = fs.createReadStream(join(__dirname, 'data.json'));

	let counter = 0;

	const result = await ndjsonToObservable(ndjsonStream)
		.pipe(
			tap(record => {
				t.is(record.firstName, data[counter].firstName);
				t.is(record.name, data[counter].name)

				counter++;
			}),
			bufferCount(4)
		)
		.toPromise();

	t.deepEqual(result, data);
});
