// pulls in the mocha describe/it globals without changing tsconfig.json
// eslint-disable-next-line spaced-comment
/// <reference types="mocha" />

import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import stream from "node:stream";

import { createDockerBuildContext, createContextTarStreamFromDirectory } from "./build-context.ts";
import type { TSpawn, TBuildEvent, TExportEvent, TRunOutputEvent } from "./build-context.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const createPassThrough = () => {
  // eslint-disable-next-line k13-engineering/no-new
  return new stream.PassThrough();
};

type TFakeProcess = {
  stdin: stream.PassThrough | null;
  stdout: stream.PassThrough;
  stderr: stream.PassThrough;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
};

const createFakeProcess = ({ withStdin }: { withStdin: boolean }): TFakeProcess => {
  // eslint-disable-next-line k13-engineering/no-new
  const events = new EventEmitter();

  const stdout = createPassThrough();
  const stderr = createPassThrough();
  const stdin = withStdin ? createPassThrough() : null;

  if (stdin !== null) {
    // the library pipes the build context in; nothing here consumes it
    stdin.resume();
  }

  // these mirror the positional signatures of the node APIs being stood in for
  /* eslint-disable k13-engineering/prefer-single-object-parameters */
  return {
    stdin,
    stdout,
    stderr,
    on: (event, listener) => {
      events.on(event, listener);
    },
    once: (event, listener) => {
      events.once(event, listener);
    },
    emit: (event, ...args) => {
      events.emit(event, ...args);
    }
  };
  /* eslint-enable k13-engineering/prefer-single-object-parameters */
};

type TSpawnCall = {
  command: string;
  args: string[];
  stdio: unknown[];
  proc: TFakeProcess;
};

const createSpawnMock = ({ withStdin = true }: { withStdin?: boolean } = {}) => {
  let calls: TSpawnCall[] = [];
  let waiters: { index: number; resolve: () => void }[] = [];

  const releaseWaiters = () => {
    waiters.filter((waiter) => {
      return waiter.index < calls.length;
    }).forEach((waiter) => {
      waiter.resolve();
    });

    waiters = waiters.filter((waiter) => {
      return waiter.index >= calls.length;
    });
  };

  // matches the positional signature of child_process.spawn
  // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
  const spawn = (command: string, args: string[], options: { stdio: unknown[] }) => {
    const proc = createFakeProcess({ withStdin });

    calls = [...calls, { command, args, stdio: options.stdio, proc }];
    releaseWaiters();

    return proc;
  };

  const callAt = ({ index }: { index: number }) => {
    return calls[index];
  };

  const callCount = () => {
    return calls.length;
  };

  const waitForCall = ({ index }: { index: number }) => {
    if (index < calls.length) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      waiters = [...waiters, { index, resolve }];
    });
  };

  return {
    spawn: spawn as unknown as TSpawn,
    callAt,
    callCount,
    waitForCall
  };
};

const makeContext = ({
  spawn,
  platform = undefined
}: {
  spawn: TSpawn;
  platform?: string | undefined;
}) => {
  return createDockerBuildContext({
    createContextTarStream: () => {
      const source = createPassThrough();
      source.end("fake-context-tar");

      return source;
    },
    platform,
    spawn
  });
};

const collectEvents = <TEvent>({ source }: { source: stream.Readable }): Promise<TEvent[]> => {
  return new Promise((resolve, reject) => {
    let events: TEvent[] = [];

    source.on("data", (event: TEvent) => {
      events = [...events, event];
    });

    source.once("end", () => {
      resolve(events);
    });

    source.once("error", reject);
  });
};

const textOf = ({
  events,
  type
}: {
  events: (TExportEvent | TRunOutputEvent | TBuildEvent)[];
  type: string;
}) => {
  return events.filter((event) => {
    return event.type === type;
  }).map((event) => {
    return decoder.decode(event.data as Uint8Array);
  }).join("");
};

const countOf = ({
  events,
  type
}: {
  events: (TExportEvent | TRunOutputEvent | TBuildEvent)[];
  type: string;
}) => {
  return events.filter((event) => {
    return event.type === type;
  }).length;
};

const writeImageId = ({ call, imageId }: { call: TSpawnCall; imageId: string }) => {
  const fd = call.stdio[3] as number;

  fs.writeSync(fd, imageId, 0);
};

// drives a fake "docker buildx build" through a successful run
const completeBuild = ({
  call,
  imageId = "sha256:feedface"
}: {
  call: TSpawnCall;
  imageId?: string;
}) => {
  if (imageId !== "") {
    writeImageId({ call, imageId });
  }

  call.proc.stderr.end(`{"id":"step-1"}\n{"id":"step-2"}\n`);
  call.proc.emit("close", 0);
};

const completeRun = ({
  call,
  stdout = "",
  stderr = "",
  code = 0
}: {
  call: TSpawnCall;
  stdout?: string;
  stderr?: string;
  code?: number;
}) => {
  call.proc.stdout.end(stdout);
  call.proc.stderr.end(stderr);
  call.proc.emit("close", code);
};

const rejectionOf = async ({ promise }: { promise: Promise<unknown> }) => {
  try {
    await promise;
  } catch (ex) {
    return { error: ex as Error };
  }

  throw Error(`expected the stream to fail, but it completed`);
};

describe("createDockerBuildContext / exportImageAsTarStream", () => {

  it("should emit build-log and data events and end", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });
    call.proc.stderr.end(`{"id":"exporting"}\n`);
    call.proc.stdout.end("TAR-BYTES");
    call.proc.emit("close", 0);

    const collected = await events;

    assert.equal(countOf({ events: collected, type: "build-log" }), 1);
    assert.equal(textOf({ events: collected, type: "data" }), "TAR-BYTES");
  });

  it("should pass buildArgs and no platform by default", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({
        buildArgs: { FLAVOUR: "vanilla" }
      })
    });

    const call = mock.callAt({ index: 0 });

    assert.ok(call.args.includes("--build-arg"));
    assert.ok(call.args.includes("FLAVOUR=vanilla"));
    assert.ok(!call.args.includes("--platform"));
    assert.ok(call.args.includes("type=tar"));

    call.proc.stderr.end();
    call.proc.stdout.end();
    call.proc.emit("close", 0);

    await events;
  });

  it("should pass the platform when one is configured", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn, platform: "linux/arm64" })
        .exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });

    assert.ok(call.args.includes("--platform"));
    assert.ok(call.args.includes("linux/arm64"));

    call.proc.stderr.end();
    call.proc.stdout.end();
    call.proc.emit("close", 0);

    await events;
  });

  it("should fail gracefully when the build exits non-zero", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });
    call.proc.stderr.end();
    call.proc.stdout.end();
    call.proc.emit("close", 7);

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("exited with code 7"), error.message);
  });

  it("should fail gracefully when the process cannot be spawned", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });
    call.proc.emit("error", Error("spawn ENOENT"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("ENOENT"), error.message);
  });

  it("should fail gracefully when the tar stream errors mid-transfer", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });
    call.proc.stdout.write("partial");
    call.proc.stdout.destroy(Error("stdout exploded"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("stdout exploded"), error.message);
  });

  it("should fail gracefully when the build log stream errors", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });
    call.proc.stderr.destroy(Error("stderr exploded"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("stderr exploded"), error.message);
  });

  it("should survive an EPIPE while writing the build context", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });

    // docker stopped reading the context; this must not take the process down
    call.proc.stdin?.emit("error", Error("EPIPE"));

    call.proc.stderr.end();
    call.proc.stdout.end();
    call.proc.emit("close", 0);

    assert.equal((await events).length, 0);
  });

});

describe("createDockerBuildContext / runImage", () => {

  it("should build, then run the reported image id", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    const buildCall = mock.callAt({ index: 0 });

    assert.ok(buildCall.args.includes("--iidfile"));
    assert.ok(buildCall.args.includes("/proc/self/fd/3"));
    assert.ok(!buildCall.args.includes("--tag"));

    completeBuild({ call: buildCall, imageId: "sha256:abc123" });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    assert.deepEqual(runCall.args, ["run", "-i", "sha256:abc123"]);

    completeRun({ call: runCall, stdout: "hello", stderr: "oops" });

    const collected = await events;

    assert.equal(countOf({ events: collected, type: "build-log" }), 2);
    assert.equal(textOf({ events: collected, type: "stdout" }), "hello");
    assert.equal(textOf({ events: collected, type: "stderr" }), "oops");
  });

  it("should pass the platform to the build when one is configured", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn, platform: "linux/amd64" })
        .runImage({ environment: {}, buildArgs: {} })
    });

    const buildCall = mock.callAt({ index: 0 });

    assert.ok(buildCall.args.includes("--platform"));
    assert.ok(buildCall.args.includes("linux/amd64"));

    completeBuild({ call: buildCall });

    await mock.waitForCall({ index: 1 });
    completeRun({ call: mock.callAt({ index: 1 }) });

    await events;
  });

  it("should pass environment entries as -e arguments", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({
        environment: { GREETING: "hello", OTHER: "value" },
        buildArgs: { FLAVOUR: "choc" }
      })
    });

    const buildCall = mock.callAt({ index: 0 });

    assert.ok(buildCall.args.includes("FLAVOUR=choc"));

    completeBuild({ call: buildCall });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    assert.deepEqual(runCall.args, [
      "run", "-i", "-e", "GREETING=hello", "-e", "OTHER=value", "sha256:feedface"
    ]);

    completeRun({ call: runCall });
    await events;
  });

  it("should omit -e arguments when environment is undefined", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({
        environment: undefined,
        buildArgs: {}
      })
    });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    assert.ok(!runCall.args.includes("-e"));

    completeRun({ call: runCall });
    await events;
  });

  it("should forward stdin written before the container exists", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    const events = collectEvents<TRunOutputEvent>({ source: duplex });

    duplex.write({ type: "stdin", data: encoder.encode("ping\n") });
    duplex.end();

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    const forwarded = await new Promise<string>((resolve) => {
      let seen = "";

      runCall.proc.stdin?.on("data", (chunk: Uint8Array) => {
        seen = `${seen}${decoder.decode(chunk)}`;

        if (seen.includes("ping")) {
          resolve(seen);
        }
      });
    });

    assert.ok(forwarded.includes("ping"), forwarded);

    completeRun({ call: runCall });
    await events;
  });

  it("should drop input events that are not stdin", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    const events = collectEvents<TRunOutputEvent>({ source: duplex });

    duplex.write({ type: "not-stdin", data: encoder.encode("ignored") });
    duplex.end();

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    let forwarded = "";
    runCall.proc.stdin?.on("data", (chunk: Uint8Array) => {
      forwarded = `${forwarded}${decoder.decode(chunk)}`;
    });

    completeRun({ call: runCall, stdout: "done" });
    await events;

    assert.equal(forwarded, "");
  });

  it("should apply backpressure when the consumer does not read", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    // more chunks than the duplex highWaterMark, with nothing reading yet
    const chunkCount = 40;

    Array.from({ length: chunkCount }).forEach((ignored, index) => {
      runCall.proc.stdout.write(`chunk-${index};`);
    });

    completeRun({ call: runCall });

    const collected = await collectEvents<TRunOutputEvent>({ source: duplex });
    const seen = textOf({ events: collected, type: "stdout" });

    Array.from({ length: chunkCount }).forEach((ignored, index) => {
      assert.ok(seen.includes(`chunk-${index};`), `missing chunk-${index}`);
    });
  });

  it("should fail gracefully when the build exits non-zero", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    const buildCall = mock.callAt({ index: 0 });
    buildCall.proc.stderr.end(`{"id":"step"}\n`);
    buildCall.proc.emit("close", 3);

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("exited with code 3"), error.message);
    assert.equal(mock.callCount(), 1, "no container may be started");
  });

  it("should fail gracefully when the build reports no image id", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    completeBuild({ call: mock.callAt({ index: 0 }), imageId: "" });

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("did not report an image id"), error.message);
    assert.equal(mock.callCount(), 1, "no container may be started");
  });

  it("should fail gracefully when the container exits non-zero", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    completeRun({ call: mock.callAt({ index: 1 }), code: 9 });

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("docker run exited with code 9"), error.message);
  });

  it("should fail gracefully when the container cannot be spawned", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    mock.callAt({ index: 1 }).proc.emit("error", Error("run spawn failed"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("run spawn failed"), error.message);
  });

  it("should fail gracefully when the container output errors", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    mock.callAt({ index: 1 }).proc.stdout.destroy(Error("container stdout exploded"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("container stdout exploded"), error.message);
  });

  it("should fail gracefully when the build log stream errors", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    mock.callAt({ index: 0 }).proc.stderr.destroy(Error("build stderr exploded"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("build stderr exploded"), error.message);
    assert.equal(mock.callCount(), 1, "no container may be started");
  });

  it("should survive an EPIPE while writing the build context", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    const buildCall = mock.callAt({ index: 0 });
    buildCall.proc.stdin?.emit("error", Error("EPIPE"));

    completeBuild({ call: buildCall });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    runCall.proc.stdin?.emit("error", Error("EPIPE"));
    completeRun({ call: runCall, stdout: "still fine" });

    assert.equal(textOf({ events: await events, type: "stdout" }), "still fine");
  });

  it("should fail gracefully when the build is spawned without stdio pipes", async () => {
    const mock = createSpawnMock({ withStdin: false });
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("without the expected stdio pipes"), error.message);
  });

});

describe("createContextTarStreamFromDirectory", () => {

  const makeDirectory = () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "node-dockerfiler-spec-"));

    fs.writeFileSync(nodePath.join(root, "kept.txt"), "kept\n");
    fs.writeFileSync(nodePath.join(root, "dropped.txt"), "dropped\n");

    return { root };
  };

  const readEntryNames = async ({ source }: { source: stream.Readable }) => {
    let raw = "";

    await new Promise<void>((resolve, reject) => {
      source.on("data", (chunk: Uint8Array) => {
        raw = `${raw}${decoder.decode(chunk)}`;
      });

      source.once("end", () => {
        resolve();
      });

      source.once("error", reject);
    });

    return { raw };
  };

  it("should include the Dockerfile and the directory contents", async () => {
    const { root } = makeDirectory();

    const { raw } = await readEntryNames({
      source: createContextTarStreamFromDirectory({
        context: root,
        ignore: undefined,
        dockerfileContent: "FROM scratch\n"
      })
    });

    assert.ok(raw.includes("Dockerfile"), "expected a Dockerfile entry");
    assert.ok(raw.includes("kept.txt"), "expected kept.txt");
    assert.ok(raw.includes("dropped.txt"), "expected dropped.txt");
  });

  it("should apply the ignore callback relative to the context", async () => {
    const { root } = makeDirectory();

    const { raw } = await readEntryNames({
      source: createContextTarStreamFromDirectory({
        context: root,
        ignore: (name) => {
          return name === "dropped.txt";
        },
        dockerfileContent: "FROM scratch\n"
      })
    });

    assert.ok(raw.includes("kept.txt"), "expected kept.txt");
    assert.ok(!raw.includes("dropped.txt"), "dropped.txt should have been ignored");
  });

});
