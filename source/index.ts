import { ReadStream } from 'fs';
import { Observable } from 'rxjs';
import * as split from 'split';
import * as stripBOM from 'strip-bom-stream';
import { JsonObject } from 'type-fest';

/**
 * Create an observable steam based from stream events
 *
 * @param stream - Stream to create the events from.
 */
export const streamToObservable = <T>(stream: ReadStream): Observable<T> => {
	return new Observable((observer): any => {
		stream
			.on('data', async (chunk: T) => {
				observer.next(chunk);
			})
			.on('error', err => {
				observer.error(err);
			})
			.on('end', () => {
				observer.complete();
			});

		// tslint:disable-next-line:typedef
		return () => {
			stream.destroy();
		};
	});
};


/**
 * Converts the NDJSON stream to an observable that will emit every record
 *
 * @param stream - NDJSON read stream
 */
export const ndjsonToObservable = <T  = unknown>(stream: ReadStream): Observable<T> => {
	return streamToObservable(stream.pipe(stripBOM()).pipe(split(/(?<=})\n(?={)/, JSON.parse)))
}
