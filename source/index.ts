import { ReadStream } from 'fs';
import { Observable } from 'rxjs';
import * as split from 'split';
import * as stripBOM from 'strip-bom-stream';
import * as streamToObservable from '@samverschueren/stream-to-observable';

/**
 * Converts the NDJSON stream to an observable that will emit every record
 *
 * @param stream - NDJSON read stream
 */
export const ndjsonToObservable = <T = unknown>(stream: ReadStream): Observable<T> =>
	streamToObservable(stream.pipe(stripBOM()).pipe(split(/(?<=})\n(?={)/, JSON.parse)));
