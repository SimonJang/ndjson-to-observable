import { Readable } from 'stream';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import split = require('split');
import stripBOM = require('strip-bom-stream');
import streamToObservable = require('@samverschueren/stream-to-observable');

/** Converts an NDJSON stream into the shared, eager observable used in 1.x. */
export const ndjsonToObservable = <T = unknown>(stream: Readable): Observable<T> => {
	let stopped = false;
	let sourceEnded = false;
	const bom = stripBOM();
	// Wrapping the value prevents split's legacy stream from treating JSON null as EOF.
	const records = split(/\r?\n/, line => {
		if (stopped || /^[ \t\r]*$/.test(line)) {
			return undefined;
		}

		return {value: JSON.parse(line) as T};
	});
	const observable = streamToObservable<{value: T}>(records);

	// The original adapter retains terminal results in a Promise. Handle rejection
	// even if all consumers unsubscribe, without changing its asynchronous delivery.
	observable.subscribe({error: () => undefined});

	const removeSourceListeners = () => {
		stream.removeListener('error', onSourceError);
		stream.removeListener('end', onSourceEnd);
		stream.removeListener('close', onSourceClose);
	};
	const stopParsing = () => {
		if (stopped) {
			return;
		}

		stopped = true;
		stream.unpipe(bom);
		bom.unpipe(records);
		bom.destroy();
		records.destroy();
		if (sourceEnded) {
			removeSourceListeners();
		}
	};
	const onSourceError = (error: Error) => {
		if (!stopped) {
			records.emit('error', error);
		}
	};
	const onSourceEnd = () => {
		sourceEnded = true;
		if (stopped) {
			removeSourceListeners();
		}
	};
	const onSourceClose = () => {
		// Node 8 can emit close before its queued destroy error. Keep the error
		// listener through that turn so the original error wins over generic close.
		setImmediate(() => {
			if (!sourceEnded && !stopped) {
				onSourceError(new Error('NDJSON input stream closed before ending'));
			}
			removeSourceListeners();
		});
	};

	stream.on('error', onSourceError);
	stream.on('end', onSourceEnd);
	stream.on('close', onSourceClose);
	bom.on('error', onSourceError);
	records.on('error', stopParsing);
	records.once('end', () => {
		stopped = true;
		removeSourceListeners();
	});

	// Construction starts reading, and the caller retains ownership of the source.
	stream.pipe(bom).pipe(records);
	return observable.pipe(map(record => record.value));
};
