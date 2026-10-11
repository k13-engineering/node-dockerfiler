// pulls in the mocha describe/it globals without changing tsconfig.json
// eslint-disable-next-line spaced-comment
/// <reference types="mocha" />

import assert from "node:assert";
import stream from "node:stream";
import { setImmediate } from "node:timers";

import tarStream from "tar-stream";

import { buildStreamToTar, buildStreamToFileInTar } from "./stream-helper.ts";
import type { TRawExportEvent } from "./build-context.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const createSink = () => {
  let written = "";

  // eslint-disable-next-line k13-engineering/no-new
  const sink = new stream.Writable({
    // the (chunk, encoding, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    write: (chunk, encoding, callback) => {
      written = `${written}${decoder.decode(chunk as Uint8Array)}`;
      callback();
    }
  });

  const text = () => {
    return written;
  };

  return { sink, text };
};

// builds a real tar so the extraction path is exercised against genuine tar bytes
const makeTar = async ({ entries }: { entries: { name: string; body: string }[] }) => {
  const pack = tarStream.pack();

  entries.forEach((entry) => {
    pack.entry({ name: entry.name }, entry.body);
  });

  pack.finalize();

  let chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    chunks = [...chunks, chunk as Uint8Array];
  }

  const total = chunks.reduce((sum, chunk) => {
    return sum + chunk.length;
  }, 0);

  const tar = new Uint8Array(total);

  chunks.reduce((offset, chunk) => {
    tar.set(chunk, offset);

    return offset + chunk.length;
  }, 0);

  return { tar };
};

const chunkify = ({ data, size }: { data: Uint8Array; size: number }) => {
  let chunks: Uint8Array[] = [];

  for (let offset = 0; offset < data.length; offset += size) {
    chunks = [...chunks, data.subarray(offset, offset + size)];
  }

  return { chunks };
};

const feed = ({
  transform,
  events
}: {
  transform: stream.Duplex;
  events: TRawExportEvent[];
}) => {
  events.forEach((event) => {
    transform.write(event);
  });

  transform.end();
};

const readAll = ({ source }: { source: stream.Readable }) => {
  return new Promise<{ text: string }>((resolve, reject) => {
    let text = "";

    source.on("data", (chunk: Uint8Array) => {
      text = `${text}${decoder.decode(chunk)}`;
    });

    source.once("end", () => {
      resolve({ text });
    });

    source.once("error", reject);
  });
};

const settle = () => {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

// a sink that accepts nothing until released, so backpressure is deterministic
const createBlockingSink = () => {
  let pending: (() => void)[] = [];
  let written = "";

  // eslint-disable-next-line k13-engineering/no-new
  const sink = new stream.Writable({
    highWaterMark: 1,
    // the (chunk, encoding, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    write: (chunk, encoding, callback) => {
      written = `${written}${decoder.decode(chunk as Uint8Array)}`;
      pending = [...pending, () => {
        callback();
      }];
    }
  });

  const release = () => {
    const releasing = pending;

    pending = [];
    releasing.forEach((resume) => {
      resume();
    });
  };

  const text = () => {
    return written;
  };

  return { sink, release, text };
};

const logEvent = ({ text }: { text: string }): TRawExportEvent => {
  return { type: "build-log", data: encoder.encode(text) };
};

const dataEvent = ({ data }: { data: Uint8Array }): TRawExportEvent => {
  return { type: "data", data };
};

// writes every chunk without waiting, reporting how many the transform actually took
const floodWithData = ({
  transform,
  chunks
}: {
  transform: stream.Duplex;
  chunks: Uint8Array[];
}) => {
  let accepted = 0;

  chunks.forEach((chunk) => {
    transform.write(dataEvent({ data: chunk }), () => {
      accepted += 1;
    });
  });

  return {
    acceptedCount: () => {
      return accepted;
    }
  };
};

const floodWithLogs = ({
  transform,
  lines
}: {
  transform: stream.Duplex;
  lines: string[];
}) => {
  let accepted = 0;

  lines.forEach((line) => {
    transform.write(logEvent({ text: line }), () => {
      accepted += 1;
    });
  });

  return {
    acceptedCount: () => {
      return accepted;
    }
  };
};

describe("buildStreamToTar", () => {

  it("should emit the tar payload and divert the build log to the sink", async () => {
    const { sink, text } = createSink();
    const transform = buildStreamToTar({ stderr: sink });

    const collected = readAll({ source: transform });

    feed({
      transform,
      events: [
        logEvent({ text: "#1 building\n" }),
        dataEvent({ data: encoder.encode("TAR-") }),
        logEvent({ text: "#2 done\n" }),
        dataEvent({ data: encoder.encode("BYTES") })
      ]
    });

    assert.equal((await collected).text, "TAR-BYTES");
    assert.equal(text(), "#1 building\n#2 done\n");
  });

  it("should stop accepting input while the stderr sink is full", async () => {
    const { sink, release } = createBlockingSink();
    const transform = buildStreamToTar({ stderr: sink });
    const { acceptedCount } = floodWithLogs({ transform, lines: ["first\n", "second\n"] });

    await settle();
    assert.equal(acceptedCount(), 0, "must not consume input while stderr is blocked");

    // one release lets exactly one log through, then it blocks again
    release();
    await settle();
    assert.equal(acceptedCount(), 1, "only the drained write may complete");

    release();
    await settle();
    assert.equal(acceptedCount(), 2);

    transform.destroy();
  });

  it("should fail, not hang, when the stderr sink errors", async () => {
    const { sink } = createBlockingSink();
    const transform = buildStreamToTar({ stderr: sink });

    const collected = readAll({ source: transform });

    // the log write is parked waiting for drain; the sink then dies instead
    transform.write(logEvent({ text: "parked\n" }));
    sink.destroy(Error("terminal went away"));

    await assert.rejects(collected, (err: Error) => {
      return err.message.includes("terminal went away");
    });

    assert.equal(sink.listenerCount("error"), 0, "must not leave a listener on the sink");
  });

  it("should emit nothing when the build produced no tar data", async () => {
    const { sink, text } = createSink();
    const transform = buildStreamToTar({ stderr: sink });

    const collected = readAll({ source: transform });

    feed({ transform, events: [logEvent({ text: "only logs\n" })] });

    assert.equal((await collected).text, "");
    assert.equal(text(), "only logs\n");
  });

});

describe("buildStreamToFileInTar", () => {

  it("should extract the requested file and divert the build log", async () => {
    const { tar } = await makeTar({
      entries: [
        { name: "other.txt", body: "not this one" },
        { name: "wanted.txt", body: "the wanted contents" },
        { name: "later.txt", body: "also not this one" }
      ]
    });

    const { sink, text } = createSink();
    const transform = buildStreamToFileInTar({ stderr: sink, filePath: "wanted.txt" });

    const collected = readAll({ source: transform });

    const { chunks } = chunkify({ data: tar, size: 100 });

    feed({
      transform,
      events: [
        logEvent({ text: "#1 exporting\n" }),
        ...chunks.map((chunk) => {
          return dataEvent({ data: chunk });
        })
      ]
    });

    assert.equal((await collected).text, "the wanted contents");
    assert.equal(text(), "#1 exporting\n");
  });

  it("should extract a file split across many small chunks", async () => {
    const body = "x".repeat(5000);
    const { tar } = await makeTar({ entries: [{ name: "big.bin", body }] });

    const { sink } = createSink();
    const transform = buildStreamToFileInTar({ stderr: sink, filePath: "big.bin" });

    const collected = readAll({ source: transform });
    const { chunks } = chunkify({ data: tar, size: 64 });

    feed({
      transform,
      events: chunks.map((chunk) => {
        return dataEvent({ data: chunk });
      })
    });

    assert.equal((await collected).text, body);
  });

  it("should stop accepting input while the stderr sink is full", async () => {
    const { sink, release } = createBlockingSink();
    const transform = buildStreamToFileInTar({ stderr: sink, filePath: "whatever.txt" });

    let accepted = 0;

    transform.write(logEvent({ text: "log line\n" }), () => {
      accepted += 1;
    });

    await settle();
    assert.equal(accepted, 0, "must not consume input while stderr is blocked");

    release();
    await settle();
    assert.equal(accepted, 1);

    transform.destroy();
  });

  it("should stop accepting input while the reader is behind", async () => {
    const body = "y".repeat(200 * 1024);
    const { tar } = await makeTar({ entries: [{ name: "big.bin", body }] });

    const { sink } = createSink();
    const transform = buildStreamToFileInTar({ stderr: sink, filePath: "big.bin" });

    const { chunks } = chunkify({ data: tar, size: 8192 });
    const { acceptedCount } = floodWithData({ transform, chunks });

    await settle();

    assert.ok(
      acceptedCount() < chunks.length,
      `nothing is reading, yet ${acceptedCount()} chunks were taken`
    );

    // once a reader shows up everything drains, and nothing may be lost on the way
    const collected = readAll({ source: transform });
    transform.end();

    assert.equal((await collected).text, body);
  });

  it("should fail, not hang, when the stderr sink errors", async () => {
    const { sink } = createBlockingSink();
    const transform = buildStreamToFileInTar({ stderr: sink, filePath: "whatever.txt" });

    const collected = readAll({ source: transform });

    transform.write(logEvent({ text: "parked\n" }));
    sink.destroy(Error("terminal went away"));

    await assert.rejects(collected, (err: Error) => {
      return err.message.includes("terminal went away");
    });

    assert.equal(sink.listenerCount("error"), 0, "must not leave a listener on the sink");
  });

  it("should fail when the requested file is not in the tar", async () => {
    const { tar } = await makeTar({ entries: [{ name: "present.txt", body: "here" }] });

    const { sink } = createSink();
    const transform = buildStreamToFileInTar({ stderr: sink, filePath: "missing.txt" });

    const collected = readAll({ source: transform });

    feed({ transform, events: [dataEvent({ data: tar })] });

    await assert.rejects(collected, (err: Error) => {
      return err.message.includes(`"missing.txt" was not found`);
    });
  });

  it("should fail when the tar payload is malformed", async () => {
    const { sink } = createSink();
    const transform = buildStreamToFileInTar({ stderr: sink, filePath: "whatever.txt" });

    const collected = readAll({ source: transform });

    feed({
      transform,
      events: [dataEvent({ data: encoder.encode("this is definitely not a tar archive") })]
    });

    await assert.rejects(collected);
  });

});
