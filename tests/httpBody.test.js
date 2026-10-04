// httpBody.test.js — Tests for the shared capped response-body reader.
import GLib from 'gi://GLib';
import { readCappedBytes } from '../src/shared/httpBody.js';
import { assert, assertEqual, runTests } from './testUtils.js';

// Minimal Gio.InputStream stand-in.  Callbacks fire synchronously so the
// promise completes without needing a main loop.
class FakeInputStream {
    constructor(chunks) {
        this._chunks = chunks.map((chunk) =>
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
        );
        this.closed = false;
        this.requestedChunkSizes = [];
        this.receivedCancellable = null;
    }

    read_bytes_async(count, _priority, cancellable, callback) {
        this.requestedChunkSizes.push(count);
        this.receivedCancellable = cancellable;
        const chunk = this._chunks.length > 0 ? this._chunks.shift() : new Uint8Array(0);
        callback(this, { bytes: new GLib.Bytes(chunk) });
    }

    read_bytes_finish(result) {
        return result.bytes;
    }

    close(_cancellable) {
        this.closed = true;
    }
}

class FailingInputStream {
    read_bytes_async(_count, _priority, _cancellable, callback) {
        callback(this, {});
    }

    read_bytes_finish() {
        throw new Error('boom');
    }

    close() {
        this.closed = true;
    }
}

async function expectRejection(fn, messagePart) {
    let error = null;
    try {
        await fn();
    } catch (e) {
        error = e;
    }
    assert(error, `expected rejection containing "${messagePart}"`);
    assert(
        String(error.message).includes(messagePart),
        `expected rejection containing "${messagePart}", got "${error.message}"`,
    );
    return error;
}

const tests = [
    [
        'readCappedBytes: concatenates chunks until EOF and closes the stream',
        async () => {
            const stream = new FakeInputStream([[1, 2, 3], [4, 5], []]);
            const result = await readCappedBytes(stream, { maxBytes: 100 });
            assertEqual(Array.from(result).join(','), '1,2,3,4,5', 'combined bytes');
            assertEqual(stream.closed, true, 'stream closed');
        },
    ],

    [
        'readCappedBytes: empty stream resolves empty and closes',
        async () => {
            const stream = new FakeInputStream([[]]);
            const result = await readCappedBytes(stream, { maxBytes: 100 });
            assertEqual(result.length, 0, 'empty result');
            assertEqual(stream.closed, true, 'stream closed');
        },
    ],

    [
        'readCappedBytes: cap exceeded rejects with the default MB message',
        async () => {
            const stream = new FakeInputStream([
                [1, 2, 3],
                [4, 5, 6],
            ]);
            await expectRejection(
                () => readCappedBytes(stream, { maxBytes: 5 }),
                'MB safety limit',
            );
            assertEqual(stream.closed, true, 'stream closed on cap');
        },
    ],

    [
        'readCappedBytes: custom makeError builds the cap error',
        async () => {
            const stream = new FakeInputStream([[1, 2, 3]]);
            const error = await expectRejection(
                () =>
                    readCappedBytes(stream, {
                        maxBytes: 2,
                        makeError: (maxBytes) => {
                            const e = new Error(`custom cap at ${maxBytes}`);
                            e.code = 'response-too-large';
                            return e;
                        },
                    }),
                'custom cap at 2',
            );
            assertEqual(error.code, 'response-too-large', 'error code preserved');
        },
    ],

    [
        'readCappedBytes: asBytes resolves a GLib.Bytes',
        async () => {
            const stream = new FakeInputStream([[7, 8, 9]]);
            const result = await readCappedBytes(stream, { maxBytes: 100, asBytes: true });
            assert(typeof result.get_data === 'function', 'result is GLib.Bytes');
            assertEqual(Array.from(result.get_data()).join(','), '7,8,9', 'bytes content');
        },
    ],

    [
        'readCappedBytes: chunk size and cancellable are forwarded',
        async () => {
            const token = { is_cancelled: () => false };
            const stream = new FakeInputStream([[1], []]);
            await readCappedBytes(stream, { maxBytes: 100, chunkBytes: 1024, cancellable: token });
            assertEqual(stream.requestedChunkSizes.join(','), '1024,1024', 'requested chunk sizes');
            assertEqual(stream.receivedCancellable, token, 'cancellable forwarded');
        },
    ],

    [
        'readCappedBytes: read errors propagate as rejections',
        async () => {
            const stream = new FailingInputStream();
            await expectRejection(() => readCappedBytes(stream, { maxBytes: 100 }), 'boom');
        },
    ],
];

await runTests(tests);
