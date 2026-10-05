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

As in 1.x, creating the adapter starts reading immediately. The observable is shared and hot: subscribers receive future records, and earlier records are not replayed. Subscribe immediately after creating the adapter to receive every record.

Unsubscribing removes that observer without destroying the input stream, including when the final observer unsubscribes. Reading continues, and a later subscription can receive future records. Completion and errors are delivered asynchronously, including to subscribers that arrive after termination.

The caller owns the input stream. Parsing stops after malformed JSON or a source failure, but the adapter does not destroy the input; the caller can destroy it when it is no longer needed.

#### stream

Type: `stream.Readable`

A readable stream containing one JSON value per line.

## License

MIT © [Simon Jang](https://github.com/SimonJang)
