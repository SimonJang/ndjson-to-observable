# ndjson-to-observable ![CI](https://github.com/SimonJang/ndjson-to-observable/workflows/CI/badge.svg?branch=master)

Transform a NDJSON stream to an [RxJS](https://www.npmjs.com/package/rxjs) observable stream.

## Requirements

 - [RxJS](https://www.npmjs.com/package/rxjs)
 - Node 8+

## Install

```
$ npm install ndjson-to-observable
```

## Usage

```js
import * as fs from 'fs';
import * as path from 'path'
import {ndjsonToObservable} from 'ndjson-to-observable';
import {tap} from 'rxjs/operators'

const stream = fs.createReadStream(path.join(__dirname, 'test.json'));

ndjsonToObservable(stream)
	.pipe(
		tap(item => console.log(item)) // JSON object
	)
	.subscribe()

```

## API

### ndjsonToObservable(stream)

#### stream

Type: `ReadableStream`

Stream of [NDJSON](http://ndjson.org/) records. Could be from a file or generated ad hoc.
