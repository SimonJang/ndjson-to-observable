# ndjson-to-observable ![CI](https://github.com/SimonJang/ndjson-to-observable/actions/workflows/ci.yml/badge.svg)

Transform a newline-delimited JSON stream into an [RxJS](https://www.npmjs.com/package/rxjs) observable.

## Requirements

- RxJS 6.5.3 or later in the RxJS 6 line
- Node.js 8 or later

## Install

```sh
npm install ndjson-to-observable rxjs
```

## Usage

```js
const fs = require('fs');
const {ndjsonToObservable} = require('ndjson-to-observable');

const stream = fs.createReadStream('records.ndjson');

ndjsonToObservable(stream).subscribe({
	next(record) {
		console.log(record);
	},
	error(error) {
		console.error(error);
	}
});
```

## API

### ndjsonToObservable(stream)

Returns an `Observable` that emits each JSON value from the readable stream. LF and CRLF delimiters, an initial UTF-8 BOM, chunk boundaries, blank lines, and a final record without a newline are supported. Invalid JSON and source-stream failures are sent to the observable's error channel.

The first subscription starts one shared, hot, non-replaying stream. Unsubscribing one observer does not affect other active observers. Unsubscribing the final observer before completion destroys the input stream; a parse or source error also destroys it. A later subscriber receives immediate completion or the retained terminal error, but earlier values are not replayed.

On Node.js 8, exact errors from delayed destruction are retained through Node's standard `destroy` implementation or an observable `_destroy` callback. Node.js 8 exposes no settlement signal when destruction started before adapter creation, or when a custom stream prevents `_destroy` observation and replaces the standard `destroy` implementation. In those cases, a generic premature-close error may win a later destroy error rather than leaving a quiet destroy pending forever; standard streams and later Node.js versions are unaffected.

Custom streams must keep their `destroy` and `_destroy` implementations stable while the observable has an active subscription; replacing lifecycle methods while consumption is running can bypass stream termination signals.

#### stream

Type: `stream.Readable`

A readable stream containing one JSON value per line.

## Migrating from 1.x

Version 2 changes ownership and timing for the input stream:

- The first subscription starts reading instead of adapter construction.
- Later subscribers receive a retained completion or error synchronously.
- Unsubscribing the final observer before termination destroys the input stream, so it cannot be reused or resumed by a later subscription.

## License

MIT © [Simon Jang](https://github.com/SimonJang)
