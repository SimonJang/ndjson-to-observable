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

#### stream

Type: `stream.Readable`

A readable stream containing one JSON value per line.

## License

MIT © [Simon Jang](https://github.com/SimonJang)
