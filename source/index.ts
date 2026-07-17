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
	let activeSubscribers = 0;
	let started = false;
	let stopped = false;
	let sourceEnded = false;
	let sourceClosed = false;
	let withoutBOM: ReturnType<typeof stripBOM> | undefined;
	let lines: ReturnType<typeof split> | undefined;

	const removeSourceGuard = () => {
		stream.removeListener('error', onSourceError);
		stream.removeListener('error', absorbLateError);
		stream.removeListener('end', onSourceEnd);
		stream.removeListener('close', onSourceClose);
		stream.removeListener('close', releaseLateSourceError);
	};

	const guardTerminalSource = () => {
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

	const onSourceError = (error: Error) => fail(error);
	const onSourceEnd = () => {
		sourceEnded = true;
	};
	const onSourceClose = () => {
		sourceClosed = true;

		if (!stopped && !sourceEnded) {
			fail(new Error('Input stream closed before ending'));
		}

		removeSourceGuard();
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
		if (stopped || line.trim() === '') {
			return;
		}

		try {
			subject.next(JSON.parse(line) as T);
		} catch (error) {
			fail(error as Error);
		}
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
