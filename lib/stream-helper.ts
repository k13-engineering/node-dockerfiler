import stream from "stream";
import tarStream from "tar-stream";

import type { TRawExportEvent } from "./build-context.ts";

// Anything that takes bytes and reports when it is full. Both node's Writable and the
// streamx writable behind tar-stream fit, so one backpressure path serves both.
type TByteSink = {
  write: (chunk: Uint8Array) => boolean;
  once: (event: "drain", listener: () => void) => unknown;
};

// The write callback is only invoked once the sink has room again, so a slow consumer
// propagates all the way back to whatever is feeding the transform.
const writeAndWait = ({
  target,
  data,
  done
}: {
  target: TByteSink;
  data: Uint8Array;
  done: () => void;
}) => {
  if (target.write(data)) {
    done();
    return;
  }

  target.once("drain", done);
};

// A failing sink would otherwise either be an uncaught exception, or leave writeAndWait
// waiting for a drain that never comes. The listener is removed again once the transform
// is done, so a long lived sink such as process.stderr does not accumulate them.
const failOnSinkError = ({
  sink,
  target
}: {
  sink: stream.Writable;
  target: stream.Duplex;
}) => {
  const onError = (err: Error) => {
    target.destroy(err);
  };

  sink.once("error", onError);

  target.once("close", () => {
    sink.off("error", onError);
  });
};

// Both helpers consume the raw variant of exportImageAsTarStream: the build log is
// forwarded to the given sink so it can be shown to the user, while the tar payload
// continues through the transform as plain bytes.
const buildStreamToTar = ({ stderr }: { stderr: stream.Writable }) => {
  // eslint-disable-next-line k13-engineering/no-new
  const output = new stream.Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    // the (chunk, encoding, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    transform: (event: TRawExportEvent, encoding, callback) => {
      if (event.type === "build-log") {
        writeAndWait({ target: stderr, data: event.data, done: callback });
        return;
      }

      callback(null, event.data);
    }
  });

  failOnSinkError({ sink: stderr, target: output });

  return output;
};

const buildStreamToFileInTar = ({
  stderr,
  filePath
}: {
  stderr: stream.Writable;
  filePath: string;
}) => {
  const extract = tarStream.extract();

  let found = false;
  let pausedEntry: { resume: () => void } | undefined = undefined;

  // eslint-disable-next-line k13-engineering/no-new
  const output = new stream.Duplex({
    writableObjectMode: true,
    readableObjectMode: false,
    read: () => {
      const entry = pausedEntry;

      pausedEntry = undefined;

      if (entry !== undefined) {
        entry.resume();
      }
    },
    // the (chunk, encoding, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    write: (event: TRawExportEvent, encoding, callback) => {
      if (event.type === "build-log") {
        writeAndWait({ target: stderr, data: event.data, done: callback });
        return;
      }

      writeAndWait({ target: extract as unknown as TByteSink, data: event.data, done: callback });
    },
    final: (callback) => {
      extract.once("finish", () => {
        if (!found) {
          callback(Error(`"${filePath}" was not found in the exported image`));
          return;
        }

        // push here is the Readable stream API, not an array mutation
        // eslint-disable-next-line fp/no-mutating-methods
        output.push(null);
        callback();
      });

      // streamx types end() as taking the final chunk; there is none to write here
      extract.end(undefined);
    }
  });

  // the (header, stream, next) signature is imposed by tar-stream
  // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
  extract.on("entry", (header, entry, next) => {
    if (header.name !== filePath) {
      entry.resume();
      entry.once("end", next);
      return;
    }

    found = true;

    entry.on("data", (chunk) => {
      // push here is the Readable stream API, not an array mutation
      // eslint-disable-next-line fp/no-mutating-methods
      if (!output.push(chunk as Uint8Array)) {
        // the reader is behind: hold the entry until read() asks for more
        entry.pause();
        pausedEntry = entry;
      }
    });

    entry.once("end", next);
  });

  extract.once("error", (err) => {
    output.destroy(err);
  });

  failOnSinkError({ sink: stderr, target: output });

  return output;
};

export {
  buildStreamToTar,
  buildStreamToFileInTar
};
