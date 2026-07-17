declare module 'split' {
	import { Transform } from 'stream';

	interface Options {
		maxLength?: number;
		trailing?: boolean;
	}

	function split(matcher?: RegExp, mapper?: (line: string) => unknown, options?: Options): Transform;

	export = split;
}
