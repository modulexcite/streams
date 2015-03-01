import { selectStreams, writableAcceptsWriteAndClose, writableAcceptsAbort, readableAcceptsReadAndCancel
  } from './stream-base';

export function jointOps(op, status) {
  function forward() {
    if (status.state === 'waiting') {
      status.ready.then(forward);
    } else if (status.state === 'errored') {
      op.error(status.result);
    } else if (status.state === 'completed') {
      op.complete(status.result);
    }
  }
  forward();
}

// Pipes data from source to dest with no transformation. Abort signal, cancel signal and space are also propagated
// between source and dest.
export function pipeOperationStreams(source, dest) {
  return new Promise((resolve, reject) => {
    const oldWindow = source.window;

    function disposeStreams(error) {
      if (writableAcceptsAbort(dest.state)) {
        dest.abort(error);
      }
      if (readableAcceptsReadAndCancel(source.state)) {
        source.abort(error);
      }
      reject(error);
    }

    function loop() {
      for (;;) {
        // Handle interrupt.
        if (source.state === 'drained') {
          reject(new TypeError('source is drained'));
          return;
        }
        if (source.state === 'cancelled') {
          reject(new TypeError('source is cancelled'));
          return;
        }

        if (dest.state === 'closed') {
          reject(new TypeError('dest is closed'));
          return;
        }
        if (dest.state === 'aborted') {
          reject(new TypeError('dest is aborted'));
          return;
        }

        // Propagate errors.

        if (source.state === 'errored') {
          if (writableAcceptsAbort(dest.state)) {
            if (source.error.constructor === Operation) {
              jointOps(source.error, dest.abort(source.error.argument));
            } else {
              dest.abort(source.error);
            }
          }
          reject(new TypeError('source is errored'));
          return;
        }

        if (dest.state === 'errored') {
          if (readableAcceptsReadAndCancel(source.state)) {
            if (dest.error.constructor === Operation) {
              jointOps(dest.error, source.cancel(dest.error.argument));
            } else {
              source.cancel(dest.error);
            }
          }
          reject(new TypeError('dest is errored'));
          return;
        }

        if (dest.state === 'writable') {
          if (source.state === 'readable') {
            const op = source.read();
            if (op.type === 'data') {
              jointOps(op, dest.write(op.argument));
            } else if (op.type === 'close') {
              jointOps(op, dest.close());

              resolve();

              return;
            } else {
              const error = new TypeError('unexpected operation type: ' + op.type);
              disposeStreams(error);
              return;
            }

            continue;
          } else {
            source.window = dest.space;
          }
        }

        selectStreams(source, dest)
            .then(loop)
            .catch(disposeStreams);
        return;
      }
    }
    loop();
  });
}

export class OperationStatus {
  constructor() {
    this._state = 'waiting';
    this._result = undefined;
    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReadyPromise = resolve;
    });
  }

  _onCompletion(v) {
    this._state = 'completed';
    this._result = v;
    this._resolveReadyPromise();
    this._resolveReadyPromise = undefined;
  }
  _onError(e) {
    this._state = 'errored';
    this._result = e;
    this._resolveReadyPromise();
    this._resolveReadyPromise = undefined;
  }

  get state() {
    return this._state;
  }
  get result() {
    return this._result;
  }
  get ready() {
    return this._readyPromise;
  }
}

export class Operation {
  constructor(type, argument, status) {
    this._type = type;
    this._argument = argument;
    this._status = status;
  }

  get type() {
    return this._type;
  }
  get argument() {
    return this._argument;
  }

  complete(result) {
    this._status._onCompletion(result);
  }
  error(reason) {
    this._status._onError(reason);
  }
}
