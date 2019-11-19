import test from 'ava';
import * as fs from 'fs';
import { join } from 'path';
import { expectType,  } from 'tsd';
import { Observable } from 'rxjs';
import { ndjsonToObservable } from '../index';

test('Type should be correct', t => {
	const ndjsonStream = fs.createReadStream(join(__dirname, 'data.json'));

	t.notThrows(() => {
		expectType<Observable<{name: string, firstName: string}>>(ndjsonToObservable<{name: string, firstName: string}>(ndjsonStream));
	});
});
