import { Readable } from 'stream';
import { Observable } from 'rxjs';
import { ndjsonToObservable } from '../lib';

interface RecordValue {
	id: number;
}

declare const stream: Readable;

const defaultResult: Observable<unknown> = ndjsonToObservable(stream);
const typedResult: Observable<RecordValue> = ndjsonToObservable<RecordValue>(stream);

void defaultResult;
void typedResult;
