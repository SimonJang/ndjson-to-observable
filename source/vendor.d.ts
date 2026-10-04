declare module 'split' {
	import { Transform } from 'stream';

	interface Options {
		maxLength?: number;
		trailing?: boolean;
	}

	function split(matcher?: RegExp, mapper?: (line: string) => unknown, options?: Options): Transform;

	export = split;
}

declare module '@samverschueren/stream-to-observable' {
	import { Stream } from 'stream';
	import { Observable } from 'rxjs';

	function streamToObservable<T>(stream: Stream): Observable<T>;
	export = streamToObservable;
}
