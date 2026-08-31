import { Readable } from 'stream';
import { Observable, Subject } from 'rxjs';
import split = require('split');
import stripBOM = require('strip-bom-stream');

const absorbLateError = () => undefined;
type SourceDestroy = (error: Error | null, callback: (error?: Error | null) => void) => void;
type SourcePublicDestroy = (
	error?: Error,
	callback?: (error?: Error | null) => void
) => Readable;
type SourceDestroyObserver = {
	onSettled: (error?: Error | null) => void;
	onStarted: () => void;
};
type SourceDestroyRegistration = {
	remove: () => void;
	wrapper: SourceDestroy;
};
const sourceDestroyRegistries = new WeakMap<Readable, {
	hadOwn: boolean;
	observers: SourceDestroyObserver[];
	original: SourceDestroy;
	wrapper: SourceDestroy;
}>();
const sourcePublicDestroyRegistries = new WeakMap<Readable, {
	callbackExpected: boolean;
	hadOwn: boolean;
	observers: SourceDestroyObserver[];
	original: SourcePublicDestroy;
	wrapper: SourcePublicDestroy;
}>();
type SourcePublicDestroyRegistration = {
	callbackExpected: boolean;
	remove: () => void;
	wrapper: SourcePublicDestroy;
};

const observeSourceDestroy = (
	stream: Readable,
	observer: SourceDestroyObserver
): SourceDestroyRegistration | undefined => {
	const readable = stream as Readable & {_destroy: SourceDestroy};
	let registry = sourceDestroyRegistries.get(stream);

	if (!registry) {
		const hadOwn = Object.prototype.hasOwnProperty.call(readable, '_destroy');
		const original = readable._destroy;
		const observers: SourceDestroyObserver[] = [];
		const wrapper: SourceDestroy = function (this: Readable, error, callback) {
			for (const current of observers.slice()) {
				current.onStarted();
			}

			original.call(this, error, settledError => {
				callback(settledError);

				for (const current of observers.slice()) {
					current.onSettled(settledError || error);
				}
			});
		};

		try {
			readable._destroy = wrapper;
		} catch {
			return undefined;
		}

		if (readable._destroy !== wrapper) {
			return undefined;
		}

		registry = {hadOwn, observers, original, wrapper};
		sourceDestroyRegistries.set(stream, registry);
	}

	registry.observers.push(observer);

	return {
		remove: () => {
			if (!registry) {
				return;
			}

			const index = registry.observers.indexOf(observer);

			if (index !== -1) {
				registry.observers.splice(index, 1);
			}

			if (registry.observers.length !== 0) {
				return;
			}

			sourceDestroyRegistries.delete(stream);

			if (readable._destroy !== registry.wrapper) {
				return;
			}

			if (registry.hadOwn) {
				readable._destroy = registry.original;
			} else {
				delete (readable as {_destroy?: SourceDestroy})._destroy;
			}
		},
		wrapper: registry.wrapper
	};
};

const observeSourcePublicDestroy = (
	stream: Readable,
	observer: SourceDestroyObserver
): SourcePublicDestroyRegistration | undefined => {
	const readable = stream as Readable & {destroy: SourcePublicDestroy};
	let registry = sourcePublicDestroyRegistries.get(stream);

	if (!registry) {
		const hadOwn = Object.prototype.hasOwnProperty.call(readable, 'destroy');
		const original = readable.destroy;
		const observers: SourceDestroyObserver[] = [];
		const wrapper: SourcePublicDestroy = function (this: Readable, error, userCallback) {
			for (const current of observers.slice()) {
				current.onStarted();
			}

			const readableState = (this as Readable & {
				_readableState?: {closed?: boolean};
			})._readableState;
			const isLegacyStream = !readableState || typeof readableState.closed !== 'boolean';

			return original.call(this, error, settledError => {
				if (userCallback) {
					userCallback(settledError);
				}

				const sourceError = settledError || error;

				for (const current of observers.slice()) {
					current.onSettled(sourceError);
				}

				if (isLegacyStream && !userCallback && sourceError) {
					const writableState = (this as Readable & {
						_writableState?: {errorEmitted?: boolean};
					})._writableState;

					if (writableState) {
						writableState.errorEmitted = true;
					}

					process.nextTick(() => {
						if (observers.length !== 0 || this.listenerCount('error') !== 0) {
							this.emit('error', sourceError);
						}
					});
				}
			});
		};

		try {
			readable.destroy = wrapper;
		} catch {
			return undefined;
		}

		if (readable.destroy !== wrapper) {
			return undefined;
		}

		registry = {
			callbackExpected: original === Readable.prototype.destroy,
			hadOwn,
			observers,
			original,
			wrapper
		};
		sourcePublicDestroyRegistries.set(stream, registry);
	}

	registry.observers.push(observer);

	return {
		callbackExpected: registry.callbackExpected,
		remove: () => {
			if (!registry) {
				return;
			}

			const index = registry.observers.indexOf(observer);

			if (index !== -1) {
				registry.observers.splice(index, 1);
			}

			if (registry.observers.length !== 0) {
				return;
			}

			sourcePublicDestroyRegistries.delete(stream);

			if (readable.destroy !== registry.wrapper) {
				return;
			}

			if (registry.hadOwn) {
				readable.destroy = registry.original;
			} else {
				delete (readable as {destroy?: SourcePublicDestroy}).destroy;
			}
		},
		wrapper: registry.wrapper
	};
};

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
		_destroy?: SourceDestroy;
		errored?: Error | null;
		_readableState?: {
			autoDestroy?: boolean;
			closed?: boolean;
			closeEmitted?: boolean;
			emitClose?: boolean;
			endEmitted?: boolean;
			errored?: Error | null;
		};
	};
	let activeSubscribers = 0;
	let started = false;
	let stopped = false;
	let sourceEnded = false;
	let sourceClosed = false;
	let sourceTerminationPending = false;
	let sourceCloseFallback: ReturnType<typeof setImmediate> | undefined;
	let sourceSettlementCheck: ReturnType<typeof setTimeout> | undefined;
	let withoutBOM: ReturnType<typeof stripBOM> | undefined;
	let lines: ReturnType<typeof split> | undefined;
	let removeSourceDestroyObserver: () => void = () => undefined;
	let removeSourcePublicDestroyObserver: () => void = () => undefined;
	let observingSourceDestroy = false;
	let observedSourceDestroy: SourceDestroy | undefined;
	let sourceDestructionObserved = false;
	let observingSourcePublicDestroy = false;
	let observedSourcePublicDestroy: SourcePublicDestroy | undefined;
	let sourcePublicDestroyCallbackExpected = false;
	const sourceDestroyStillObserved = () => observingSourceDestroy &&
		readable._destroy === observedSourceDestroy;
	const sourcePublicDestroyStillObserved = () => observingSourcePublicDestroy &&
		readable.destroy === observedSourcePublicDestroy;

	const clearSourceCloseFallback = () => {
		if (sourceCloseFallback) {
			clearImmediate(sourceCloseFallback);
			sourceCloseFallback = undefined;
		}
	};
	const clearSourceSettlementCheck = () => {
		if (sourceSettlementCheck) {
			clearTimeout(sourceSettlementCheck);
			sourceSettlementCheck = undefined;
		}
	};
	const getStoredSourceError = () => {
		const readableState = readable._readableState;

		return readable.errored || (readableState && readableState.errored);
	};
	const removeSourceGuard = () => {
		clearSourceCloseFallback();
		clearSourceSettlementCheck();
		removeSourceDestroyObserver();
		removeSourcePublicDestroyObserver();
		stream.removeListener('error', onSourceError);
		stream.removeListener('error', absorbLateError);
		stream.removeListener('end', onSourceEnd);
		stream.removeListener('close', onSourceClose);
		stream.removeListener('close', removeSourceGuard);
	};

	const guardTerminalSource = (waitForClose: boolean) => {
		clearSourceCloseFallback();
		stream.removeListener('error', onSourceError);
		stream.removeListener('end', onSourceEnd);
		stream.removeListener('close', onSourceClose);

		if (waitForClose && !sourceClosed) {
			const readableState = readable._readableState;

			if (readableState && readableState.emitClose === false && typeof readableState.closed === 'boolean') {
				stream.on('error', absorbLateError);

				if (readableState.closed) {
					setImmediate(removeSourceGuard);
				} else if (stream.destroyed || sourceEnded) {
					scheduleSourceSettlementCheck();
				}
			} else {
				stream.on('error', absorbLateError);
				stream.once('close', removeSourceGuard);
			}
		} else {
			clearSourceSettlementCheck();
			removeSourceDestroyObserver();
			removeSourcePublicDestroyObserver();
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
		guardTerminalSource(true);
		stopPipeline(true);
		subject.error(error);
	};

	const onSourceError = (error: Error) => {
		clearSourceCloseFallback();
		fail(error);
	};
	const onSourceEnd = () => {
		if (stream.destroyed || sourceTerminationPending) {
			waitForSourceTermination();

			const readableState = readable._readableState;

			if ((!readableState || typeof readableState.closed !== 'boolean') && !sourceDestructionObserved) {
				scheduleSourceCloseFallback();
			}

			return;
		}

		sourceEnded = true;
		clearSourceCloseFallback();

		if (!started) {
			onEnd();
		}
	};
	const failPendingSourceClose = () => {
		sourceCloseFallback = undefined;

		if (stopped || sourceEnded) {
			return;
		}

		fail(getStoredSourceError() || new Error('Input stream closed before ending'));
	};
	const scheduleSourceCloseFallback = () => {
		sourceTerminationPending = true;

		if (!sourceCloseFallback) {
			// Node 8 exposes destruction start but no settlement state. If destruction
			// began before it could be observed, waiting for a quiet destroy would hang.
			sourceCloseFallback = setImmediate(failPendingSourceClose);
		}
	};
	const checkSourceSettlement = () => {
		sourceSettlementCheck = undefined;
		const readableState = readable._readableState;

		if (!stream.destroyed) {
			scheduleSourceSettlementCheck();
			return;
		}

		if (!sourceEnded) {
			sourceTerminationPending = true;
		}

		if (!readableState || typeof readableState.closed !== 'boolean') {
			if (!stopped && !sourceEnded) {
				scheduleSourceCloseFallback();
			} else if (stopped) {
				removeSourceGuard();
			}

			return;
		}

		if (!readableState.closed) {
			scheduleSourceSettlementCheck();
			return;
		}

		sourceClosed = true;

		if (!stopped && sourceTerminationPending && !sourceEnded) {
			const sourceError = getStoredSourceError();

			if (sourceError) {
				fail(sourceError);
			} else {
				scheduleSourceCloseFallback();
			}
		} else if (stopped) {
			removeSourceGuard();
		}
	};
	const scheduleSourceSettlementCheck = () => {
		if (!sourceSettlementCheck) {
			sourceSettlementCheck = setTimeout(checkSourceSettlement, 25);
			const timer = sourceSettlementCheck as ReturnType<typeof setTimeout> & {unref?: () => void};

			if (activeSubscribers === 0 && timer.unref) {
				timer.unref();
			}
		}
	};
	const waitForSourceTermination = () => {
		sourceTerminationPending = true;
		const readableState = readable._readableState;

		if ((!readableState || typeof readableState.closed !== 'boolean') && stream.destroyed && !sourceDestructionObserved) {
			scheduleSourceCloseFallback();
		} else if (readableState && readableState.emitClose === false && typeof readableState.closed === 'boolean') {
			if (readableState.closed) {
				sourceClosed = true;
				scheduleSourceCloseFallback();
			} else if (stream.destroyed) {
				scheduleSourceSettlementCheck();
			}
		}
	};
	const onSourceDestroySettled = (error?: Error | null) => {
		const sourceError = error || getStoredSourceError();

		if (!stopped && sourceTerminationPending && !sourceEnded) {
			setImmediate(removeSourceGuard);
			fail(sourceError || new Error('Input stream closed before ending'));
		} else if (stopped) {
			setImmediate(removeSourceGuard);
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

		if (sourceTerminationPending) {
			return;
		}

		stopped = true;
		const readableState = readable._readableState;
		guardTerminalSource(Boolean(stream.destroyed || (readableState && readableState.autoDestroy)));
		stopPipeline(false);
		subject.complete();
	};
	const onLine = (line: string) => {
		if (stopped || sourceTerminationPending || /^[\t\n\r ]*$/.test(line)) {
			return;
		}

		if (stream.destroyed && !sourceEnded) {
			waitForSourceTermination();
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

	const sourceDestroyObserverRemoval = observeSourceDestroy(stream, {
		onSettled: onSourceDestroySettled,
		onStarted: () => {
			sourceDestructionObserved = true;

			if (!stopped && !sourceEnded) {
				sourceTerminationPending = true;
			}
		}
	});

	if (sourceDestroyObserverRemoval) {
		observingSourceDestroy = true;
		observedSourceDestroy = sourceDestroyObserverRemoval.wrapper;
		removeSourceDestroyObserver = sourceDestroyObserverRemoval.remove;
	}

	const sourcePublicDestroyObserverRemoval = observeSourcePublicDestroy(stream, {
		onSettled: onSourceDestroySettled,
		onStarted: () => {
			sourceDestructionObserved = true;

			if (!stopped && !sourceEnded) {
				sourceTerminationPending = true;
			}

			if (!sourceDestroyStillObserved() && !sourcePublicDestroyCallbackExpected) {
				scheduleSourceSettlementCheck();
			}
		}
	});

	if (sourcePublicDestroyObserverRemoval) {
		observingSourcePublicDestroy = true;
		observedSourcePublicDestroy = sourcePublicDestroyObserverRemoval.wrapper;
		sourcePublicDestroyCallbackExpected = sourcePublicDestroyObserverRemoval.callbackExpected;
		removeSourcePublicDestroyObserver = sourcePublicDestroyObserverRemoval.remove;
	}

	stream.prependListener('error', onSourceError);
	stream.prependOnceListener('end', onSourceEnd);
	stream.prependOnceListener('close', onSourceClose);

	const readableState = readable._readableState;
	sourceEnded = Boolean(readableState && readableState.endEmitted);
	sourceClosed = Boolean(readableState && readableState.closeEmitted);
	const storedSourceError = getStoredSourceError();

	if (storedSourceError) {
		onSourceError(storedSourceError);
	} else if (sourceClosed && !sourceEnded) {
		onSourceClose();
	} else if (sourceEnded) {
		onEnd();
	} else if (stream.destroyed && !sourceEnded) {
		waitForSourceTermination();
	}

	return new Observable<T>(subscriber => {
		activeSubscribers++;

		const sourceDestroyObserved = sourceDestroyStillObserved();
		const sourcePublicDestroyObserved = sourcePublicDestroyStillObserved();

		if (!sourceDestroyObserved && !sourcePublicDestroyObserved && !stopped) {
			scheduleSourceSettlementCheck();
		}

		if (sourceSettlementCheck) {
			const timer = sourceSettlementCheck as ReturnType<typeof setTimeout> & {ref?: () => void};

			if (timer.ref) {
				timer.ref();
			}
		}

		const subjectSubscription = subject.subscribe(subscriber);

		if (!started && !stopped) {
			started = true;
			start();
		}

		return () => {
			subjectSubscription.unsubscribe();
			activeSubscribers--;

			if (activeSubscribers === 0 && sourceSettlementCheck) {
				const timer = sourceSettlementCheck as ReturnType<typeof setTimeout> & {unref?: () => void};

				if (timer.unref) {
					timer.unref();
				}
			}

			if (activeSubscribers === 0 && !stopped) {
				const sourceError = getStoredSourceError();

				if (sourceError) {
					fail(sourceError);
				} else if (sourceTerminationPending || (stream.destroyed && !sourceEnded)) {
					waitForSourceTermination();
					stopPipeline(true);
				} else {
					stopped = true;
					guardTerminalSource(true);
					stopPipeline(true);
					subject.complete();
				}
			}
		};
	});
};
