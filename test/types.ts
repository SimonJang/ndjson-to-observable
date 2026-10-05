import { Readable } from 'stream';
import { Observable } from 'rxjs';
import { ndjsonToObservable } from '../lib';

interface RecordValue {
	id: number;
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
	(<T>() => T extends B ? 1 : 2) ? true : false;
type ObservableValue<T> = T extends Observable<infer Value> ? Value : never;

declare const stream: Readable;

const defaultResult = ndjsonToObservable(stream);
const defaultTypeIsUnknown: Equal<ObservableValue<typeof defaultResult>, unknown> = true;
const typedResult: Observable<RecordValue> = ndjsonToObservable<RecordValue>(stream);

void defaultTypeIsUnknown;
void typedResult;
