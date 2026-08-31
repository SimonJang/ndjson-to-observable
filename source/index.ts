import { Readable } from 'stream';
import { Observable, Subject } from 'rxjs';
import split = require('split');
import stripBOM = require('strip-bom-stream');

const absorbLateError = () => undefined;

function releaseLateSourceError(this: Readable) {
	this.removeListener('error', absorbLateError);
	this.removeListener('close', releaseLateSourceError);
}

/**
 * Converts an NDJSON stream to one shared, hot observable.
 *
 * The first subscriber starts consumption. A terminal error is retained for
 * later subscribers, and final early unsubscription destroys the input stream.
 *
 * @param stream - NDJSON readable stream
 */
export const ndjsonToObservable = <T = unknown>(stream: Readable): Observable<T> => {
	const subject = new Subject<T>();
	const readable = stream as Readable & {
		errored?: Error | null;
		_readableState?: {
			closed?: boolean;
			closeEmitted?: boolean;
			endEmitted?: boolean;
			errored?: Error | null;
		};
	};
	let activeSubscribers = 0;
	let started = false;
	let stopped = false;
	let sourceEnded = false;
	let sourceClosed = false;
	let sourceCloseFallback: ReturnType<typeof setImmediate> | undefined;
	let withoutBOM: ReturnType<typeof stripBOM> | undefined;
	let lines: ReturnType<typeof split> | undefined;

	const clearSourceCloseFallback = () => {
		if (sourceCloseFallback) {
			clearImmediate(sourceCloseFallback);
			sourceCloseFallback = undefined;
		}
	};

	const getStoredSourceError = () => {
		const readableState = readable._readableState;

		return readable.errored || (readableState && readableState.errored);
	};

	const removeSourceGuard = () => {
		clearSourceCloseFallback();
		stream.removeListener('error', onSourceError);
		stream.removeListener('error', absorbLateError);
		stream.removeListener('end', onSourceEnd);
		stream.removeListener('close', onSourceClose);
		stream.removeListener('close', releaseLateSourceError);
	};

	const guardTerminalSource = () => {
		clearSourceCloseFallback();
		stream.removeListener('error', onSourceError);
		stream.removeListener('end', onSourceEnd);
		stream.removeListener('close', onSourceClose);

		if (!sourceClosed) {
			stream.on('error', absorbLateError);
			stream.once('close', releaseLateSourceError);
		}
	};

	const stopPipeline = (destroy: boolean) => {
		const currentLines = lines;
		const currentWithoutBOM = withoutBOM;

		if (currentLines) {
			currentLines.removeListener('data', onLine);
			currentLines.removeListener('end', onEnd);
			currentLines.removeListener('error', onTransformError);
			currentLines.on('error', absorbLateError);
		}

		if (currentWithoutBOM) {
			currentWithoutBOM.removeListener('error', onTransformError);
			currentWithoutBOM.on('error', absorbLateError);
		}

		if (currentWithoutBOM && currentLines) {
			currentWithoutBOM.unpipe(currentLines);
		}

		if (currentWithoutBOM) {
			stream.unpipe(currentWithoutBOM);
		}

		if (destroy) {
			if (currentLines) {
				currentLines.destroy();
			}

			if (currentWithoutBOM) {
				currentWithoutBOM.destroy();
			}

			stream.destroy();
		}

		lines = undefined;
		withoutBOM = undefined;
	};

	const fail = (error: Error) => {
		if (stopped) {
			return;
		}

		stopped = true;
		guardTerminalSource();
		stopPipeline(true);
		subject.error(error);
	};

	const onSourceError = (error: Error) => {
		clearSourceCloseFallback();
		fail(error);
	};
	const onSourceEnd = () => {
		sourceEnded = true;
		clearSourceCloseFallback();
	};
	const failPendingSourceClose = () => {
		sourceCloseFallback = undefined;

		if (stopped || sourceEnded) {
			return;
		}

		fail(getStoredSourceError() || new Error('Input stream closed before ending'));
	};
	const scheduleSourceCloseFallback = () => {
		if (!sourceCloseFallback) {
			sourceCloseFallback = setImmediate(failPendingSourceClose);
		}
	};
	const onSourceClose = () => {
		sourceClosed = true;

		if (!stopped && !sourceEnded) {
			const sourceError = getStoredSourceError();

			if (sourceError) {
				fail(sourceError);
			} else {
				scheduleSourceCloseFallback();
			}
		}

		if (stopped) {
			removeSourceGuard();
		}
	};
	const onTransformError = (error: Error) => fail(error);
	const onEnd = () => {
		if (stopped) {
			return;
		}

		stopped = true;
		guardTerminalSource();
		stopPipeline(false);
		subject.complete();
	};
	const onLine = (line: string) => {
		if (stopped || /^[\t\n\r ]*$/.test(line)) {
			return;
		}

		let value: T;

		try {
			value = JSON.parse(line) as T;
		} catch (error) {
			fail(error as Error);
			return;
		}

		subject.next(value);
	};

	const start = () => {
		withoutBOM = stripBOM();
		lines = split(/\r?\n/);

		withoutBOM.on('error', onTransformError);
		lines.on('error', onTransformError);
		lines.on('data', onLine);
		lines.once('end', onEnd);

		stream.pipe(withoutBOM).pipe(lines);
	};

	stream.on('error', onSourceError);
	stream.once('end', onSourceEnd);
	stream.once('close', onSourceClose);

	const readableState = readable._readableState;
	sourceEnded = Boolean(readableState && readableState.endEmitted);
	sourceClosed = Boolean(readableState && readableState.closeEmitted);
	const storedSourceError = getStoredSourceError();

	if (storedSourceError) {
		onSourceError(storedSourceError);
	} else if (sourceClosed && !sourceEnded) {
		onSourceClose();
	} else if (stream.destroyed && !sourceEnded) {
		scheduleSourceCloseFallback();
	}

	return new Observable<T>(subscriber => {
		activeSubscribers++;
		const subjectSubscription = subject.subscribe(subscriber);

		if (!started && !stopped) {
			started = true;
			start();
		}

		return () => {
			subjectSubscription.unsubscribe();
			activeSubscribers--;

			if (activeSubscribers === 0 && !stopped) {
				stopped = true;
				guardTerminalSource();
				stopPipeline(true);
				subject.complete();
			}
		};
	});
};
