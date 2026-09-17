// pulls in the mocha describe/it globals without changing tsconfig.json
// eslint-disable-next-line spaced-comment
/// <reference types="mocha" />

import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import stream from "node:stream";
import { setImmediate, setTimeout } from "node:timers";

import { createDockerBuildContext, createContextTarStreamFromDirectory } from "./build-context.ts";
import type {
  TSpawn,
  TBuildEvent,
  TExportEvent,
  TRunOutputEvent,
  TRawExportEvent,
  TRawRunOutputEvent
} from "./build-context.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const createPassThrough = () => {
  // eslint-disable-next-line k13-engineering/no-new
  return new stream.PassThrough();
};

type TFakeProcess = {
  stdin: stream.PassThrough;
  stdout: stream.PassThrough;
  stderr: stream.PassThrough;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  kill: (signal?: string) => boolean;
  unref: () => void;
  killCount: () => number;
  signalsSent: () => string[];
  hasExited: () => boolean;
};

// ignoresSigterm stands in for a docker process that will not wind down on its own, so
// that the escalation to SIGKILL can be observed
const createFakeProcess = ({
  ignoresSigterm = false
}: {
  ignoresSigterm?: boolean;
} = {}): TFakeProcess => {
  // eslint-disable-next-line k13-engineering/no-new
  const events = new EventEmitter();

  const stdout = createPassThrough();
  const stderr = createPassThrough();
  const stdin = createPassThrough();

  let signals: string[] = [];
  let exited = false;

  // the library pipes the build context in; nothing here consumes it
  stdin.resume();

  // mirrors the positional signature of EventEmitter.emit
  // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
  const emit = (event: string, ...args: unknown[]) => {
    if (event === "close") {
      exited = true;
    }

    events.emit(event, ...args);
  };

  const endsTheProcess = ({ signal }: { signal: string }) => {
    return !ignoresSigterm || signal === "SIGKILL";
  };

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
    emit,
    // node reports a signal it could not deliver as false, which is what an already
    // exited process does; a killed one closes with no exit code
    kill: (signal = "SIGTERM") => {
      if (exited) {
        return false;
      }

      signals = [...signals, signal];

      if (endsTheProcess({ signal })) {
        emit("close", null);
      }

      return true;
    },
    // the library unrefs the processes it does not wait for
    unref: () => {
      return undefined;
    },
    killCount: () => {
      return signals.length;
    },
    signalsSent: () => {
      return signals;
    },
    hasExited: () => {
      return exited;
    }
  };
  /* eslint-enable k13-engineering/prefer-single-object-parameters */
};

type TSpawnCall = {
  command: string;
  args: string[];
  stdio: unknown;
  proc: TFakeProcess;
};

// onSpawn runs while the process is being created, which is the only way to reproduce a
// consumer that gives up in the window between deciding to start docker and being able to
// tie its lifetime to the stream
const createSpawnMock = ({
  ignoresSigterm = false,
  onSpawn = () => {
    return undefined;
  }
}: {
  ignoresSigterm?: boolean;
  onSpawn?: (details: { index: number }) => void;
} = {}) => {
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
  const spawn = (command: string, args: string[], options: { stdio: unknown }) => {
    const proc = createFakeProcess({ ignoresSigterm });
    const index = calls.length;

    calls = [...calls, { command, args, stdio: options.stdio, proc }];
    onSpawn({ index });
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

const endedContext = () => {
  const source = createPassThrough();
  source.end("fake-context-tar");

  return source;
};

// a context factory that hands out one specific stream, so a test can drive it
const providing = ({ context }: { context: stream.Readable }) => {
  return () => {
    return context;
  };
};

const makeContext = ({
  spawn,
  platform = undefined,
  createContext = endedContext,
  killGracePeriodMs = undefined
}: {
  spawn: TSpawn;
  platform?: string | undefined;
  createContext?: () => stream.Readable;
  killGracePeriodMs?: number | undefined;
}) => {
  return createDockerBuildContext({
    createContextTarStream: createContext,
    platform,
    killGracePeriodMs,
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

// every run gets a generated container name, which the argument assertions are not about
const withoutName = ({ args }: { args: string[] }) => {
  const at = args.indexOf("--name");

  return [...args.slice(0, at), ...args.slice(at + 2)];
};

const containerNameOf = ({ call }: { call: TSpawnCall }) => {
  return call.args[call.args.indexOf("--name") + 1];
};

// buildx unlinks the path and writes it afresh; the fake does the same
const writeImageId = ({ call, imageId }: { call: TSpawnCall; imageId: string }) => {
  const imageIdPath = call.args[call.args.indexOf("--iidfile") + 1];

  fs.rmSync(imageIdPath, { force: true });
  fs.writeFileSync(imageIdPath, `${imageId}\n`);
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

// writes every block straight away, reporting whether the stream ever pushed back
const flood = ({
  target,
  block,
  blockCount
}: {
  target: stream.Writable;
  block: string;
  blockCount: number;
}) => {
  let backpressured = false;

  Array.from({ length: blockCount }).forEach(() => {
    if (!target.write(block)) {
      backpressured = true;
    }
  });

  return { backpressured };
};

// buildx unlinks and recreates the iidfile, so it must be a real, writable location
// rather than a descriptor path such as /proc/self/fd/3, which cannot be unlinked
const assertUsableImageIdPath = ({ call }: { call: TSpawnCall }) => {
  const imageIdPath = call.args[call.args.indexOf("--iidfile") + 1];

  assert.ok(call.args.includes("--iidfile"));
  assert.ok(nodePath.isAbsolute(imageIdPath), imageIdPath);
  assert.ok(!imageIdPath.startsWith("/proc/"), `must not be a descriptor path: ${imageIdPath}`);
  assert.ok(fs.existsSync(nodePath.dirname(imageIdPath)), "its directory must exist");
};

const settle = () => {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

// Destroying has to complete on its own; a test that needs this to time out has already
// found the hang it was looking for.
const destroyAndWaitForClose = async ({
  target,
  error = undefined
}: {
  target: stream.Readable;
  error?: Error | undefined;
}) => {
  const closed = new Promise<void>((resolve) => {
    // a stream that is already gone will not emit "close" a second time
    if (target.destroyed) {
      resolve();
      return;
    }

    target.once("close", resolve);
  });

  // a destroy with an error still has to be observable, so it is never left unhandled
  target.once("error", () => {
    return undefined;
  });

  target.destroy(error);

  await closed;

  // whatever the destroy set in motion has to have run by the time this returns
  await settle();
  await settle();
};

const callsMade = ({ mock }: { mock: ReturnType<typeof createSpawnMock> }) => {
  return Array.from({ length: mock.callCount() }).map((ignored, index) => {
    return mock.callAt({ index });
  });
};

const isRemoval = ({ call }: { call: TSpawnCall }) => {
  return call.args[0] === "rm";
};

// A container outlives the client that started it, so a run whose client had to be
// signalled is only really stopped once the container has been removed as well.
const assertContainerRemoved = ({
  call,
  removed
}: {
  call: TSpawnCall;
  removed: string[];
}) => {
  if (call.args[0] !== "run" || call.proc.killCount() === 0) {
    return;
  }

  assert.ok(
    removed.includes(containerNameOf({ call })),
    `the container of "${call.args.join(" ")}" was left behind`
  );
};

// The point of every destroy test: once the stream is gone, nothing docker was asked to
// do may still be running, whichever stage it had reached.
const assertNothingLeftRunning = ({ mock }: { mock: ReturnType<typeof createSpawnMock> }) => {
  const calls = callsMade({ mock });

  const removed = calls.filter((call) => {
    return isRemoval({ call });
  }).map((call) => {
    return call.args[call.args.length - 1];
  });

  calls.filter((call) => {
    return !isRemoval({ call });
  }).forEach((call) => {
    assert.ok(
      call.proc.hasExited(),
      `"${call.command} ${call.args.join(" ")}" is still running`
    );

    assertContainerRemoved({ call, removed });
  });
};

// createImageIdFile makes one directory per build; a destroyed stream has to take it with
// it, or every abandoned build would leave one behind
const imageIdDirectoryOf = ({ call }: { call: TSpawnCall }) => {
  return nodePath.dirname(call.args[call.args.indexOf("--iidfile") + 1]);
};

// for the few things that cannot be observed by awaiting a stream event, such as a kill
// that only escalates once a grace period has passed
const waitUntil = ({ condition }: { condition: () => boolean }) => {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2000;

    const poll = () => {
      if (condition()) {
        resolve();
        return;
      }

      if (Date.now() > deadline) {
        reject(Error(`timed out waiting for the condition`));
        return;
      }

      setTimeout(poll, 1);
    };

    poll();
  });
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

  it("should fail on a non-zero exit even while its stdio is still open", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });

    // partial output, and neither stream is ended: the exit code alone must fail the stream
    call.proc.stderr.write(`{"id":"exporting"}\n`);
    call.proc.stdout.write("half-a-tar");
    call.proc.emit("close", 1);

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("docker build exited with code 1"), error.message);
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

  it("should fail, not crash, when the build context stream errors", async () => {
    const mock = createSpawnMock();
    const context = createPassThrough();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn, createContext: providing({ context }) }).exportImageAsTarStream({ buildArgs: {} })
    });

    // e.g. tar-fs hitting an unreadable directory while docker is still consuming it
    context.destroy(Error("context directory vanished"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("context directory vanished"), error.message);
    assert.equal(mock.callAt({ index: 0 }).proc.killCount(), 1, "docker must be stopped");
  });

  it("should stop docker and the context when the consumer destroys the stream", async () => {
    const mock = createSpawnMock();
    const context = createPassThrough();
    const output = makeContext({ spawn: mock.spawn, createContext: providing({ context }) }).exportImageAsTarStream({ buildArgs: {} });

    const closed = new Promise<void>((resolve) => {
      output.once("close", () => {
        resolve();
      });
    });

    output.destroy();
    await closed;

    assert.equal(mock.callAt({ index: 0 }).proc.killCount(), 1, "docker must be killed");
    assert.ok(context.destroyed, "the context stream must be released");
  });

  it("should fail gracefully when the build log is not valid json", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });
    call.proc.stderr.end("this is not rawjson progress\n");

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("Invalid JSON"), error.message);
  });

  it("should survive an EPIPE while writing the build context", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });

    // docker stopped reading the context; this must not take the process down
    call.proc.stdin.emit("error", Error("EPIPE"));

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

    assertUsableImageIdPath({ call: buildCall });
    assert.ok(!buildCall.args.includes("--tag"));

    completeBuild({ call: buildCall, imageId: "sha256:abc123" });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    assert.deepEqual(withoutName({ args: runCall.args }), ["run", "--rm", "-i", "sha256:abc123"]);

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

    assert.deepEqual(withoutName({ args: runCall.args }), [
      "run", "--rm", "-i", "-e", "GREETING=hello", "-e", "OTHER=value", "sha256:feedface"
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

      runCall.proc.stdin.on("data", (chunk: Uint8Array) => {
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
    runCall.proc.stdin.on("data", (chunk: Uint8Array) => {
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

});

describe("createDockerBuildContext / runImage backpressure", () => {

  it("should backpressure the container output while nothing reads", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    // the buffers along the chain are object mode, so what matters is the chunk count
    const block = "z".repeat(1024);
    const blockCount = 2000;

    const { backpressured } = flood({ target: runCall.proc.stdout, block, blockCount });

    assert.ok(backpressured, "the container output must be backpressured");

    // a reader shows up late, and still gets every byte
    const collected = collectEvents<TRunOutputEvent>({ source: duplex });

    runCall.proc.stdout.end();
    runCall.proc.stderr.end();
    runCall.proc.emit("close", 0);

    const seen = textOf({ events: await collected, type: "stdout" });

    assert.equal(seen.length, block.length * blockCount);
  });

  it("should backpressure the json build log through JSONStream while nothing reads", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    const buildCall = mock.callAt({ index: 0 });

    // JSONStream is an old style through stream; this proves it still pushes back
    const block = `{"id":"${"j".repeat(1000)}"}\n`;
    const blockCount = 2000;

    const { backpressured } = flood({ target: buildCall.proc.stderr, block, blockCount });

    assert.ok(backpressured, "the json build log must be backpressured");

    const collected = collectEvents<TRunOutputEvent>({ source: duplex });

    writeImageId({ call: buildCall, imageId: "sha256:feedface" });
    buildCall.proc.stderr.end();
    buildCall.proc.emit("close", 0);

    await mock.waitForCall({ index: 1 });
    completeRun({ call: mock.callAt({ index: 1 }) });

    assert.equal(countOf({ events: await collected, type: "build-log" }), blockCount);
  });

  it("should backpressure the build log while nothing reads", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImageRaw({
      environment: {},
      buildArgs: {}
    });

    const buildCall = mock.callAt({ index: 0 });

    // the buffers along the chain are object mode, so what matters is the chunk count
    const block = "l".repeat(1024);
    const blockCount = 2000;

    const { backpressured } = flood({ target: buildCall.proc.stderr, block, blockCount });

    assert.ok(backpressured, "the build log must be backpressured");

    const collected = collectEvents<TRawRunOutputEvent>({ source: duplex });

    writeImageId({ call: buildCall, imageId: "sha256:feedface" });
    buildCall.proc.stderr.end();
    buildCall.proc.emit("close", 0);

    await mock.waitForCall({ index: 1 });
    completeRun({ call: mock.callAt({ index: 1 }) });

    const seen = textOf({ events: await collected, type: "build-log" });

    assert.equal(seen.length, block.length * blockCount);
  });

});

describe("createDockerBuildContext / runImage failures", () => {

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

  it("should fail on a non-zero build exit even while its stdio is still open", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    const buildCall = mock.callAt({ index: 0 });

    buildCall.proc.stderr.write(`{"id":"step"}\n`);
    buildCall.proc.emit("close", 5);

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("docker build exited with code 5"), error.message);
    assert.equal(mock.callCount(), 1, "no container may be started");
  });

  it("should fail on a non-zero container exit even while its stdio is still open", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} })
    });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    runCall.proc.stdout.write("partial output");
    runCall.proc.emit("close", 2);

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("docker run exited with code 2"), error.message);
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
    buildCall.proc.stdin.emit("error", Error("EPIPE"));

    completeBuild({ call: buildCall });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    runCall.proc.stdin.emit("error", Error("EPIPE"));
    completeRun({ call: runCall, stdout: "still fine" });

    assert.equal(textOf({ events: await events, type: "stdout" }), "still fine");
  });

  it("should fail, not crash, when the build context stream errors", async () => {
    const mock = createSpawnMock();
    const context = createPassThrough();
    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn, createContext: providing({ context }) }).runImage({ environment: {}, buildArgs: {} })
    });

    context.destroy(Error("context directory vanished"));

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("context directory vanished"), error.message);
    assert.equal(mock.callAt({ index: 0 }).proc.killCount(), 1, "the build must be stopped");
    assert.equal(mock.callCount(), 1, "no container may be started");
  });

  it("should stop the build when the consumer destroys the duplex mid-build", async () => {
    const mock = createSpawnMock();
    const context = createPassThrough();
    const duplex = makeContext({ spawn: mock.spawn, createContext: providing({ context }) }).runImage({ environment: {}, buildArgs: {} });

    const closed = new Promise<void>((resolve) => {
      duplex.once("close", () => {
        resolve();
      });
    });

    duplex.destroy();
    await closed;
    await settle();

    assert.equal(mock.callAt({ index: 0 }).proc.killCount(), 1, "the build must be killed");
    assert.ok(context.destroyed, "the context stream must be released");
    assert.equal(mock.callCount(), 1, "no container may be started");
  });

  it("should fail gracefully when spawning the build throws", async () => {
    const throwingSpawn = (() => {
      throw Error("spawn is not permitted");
    }) as unknown as TSpawn;

    const events = collectEvents<TRunOutputEvent>({
      source: makeContext({ spawn: throwingSpawn }).runImage({ environment: {}, buildArgs: {} })
    });

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("spawn is not permitted"), error.message);
  });

  it("should stop the container when the consumer destroys the duplex mid-run", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    const closed = new Promise<void>((resolve) => {
      duplex.once("close", () => {
        resolve();
      });
    });

    duplex.destroy();
    await closed;

    assert.equal(runCall.proc.killCount(), 1, "the container must be killed");
  });

});

describe("createDockerBuildContext / raw log variants", () => {

  it("should ask docker for plain progress and forward the log untouched", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRawExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStreamRaw({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });

    assert.ok(call.args.includes("plain"), call.args.join(" "));
    assert.ok(!call.args.includes("rawjson"), call.args.join(" "));

    call.proc.stderr.end("#1 [internal] load build definition\n");
    call.proc.stdout.end("TAR-BYTES");
    call.proc.emit("close", 0);

    const collected = await events;

    assert.equal(textOf({ events: collected, type: "build-log" }), "#1 [internal] load build definition\n");
    assert.equal(textOf({ events: collected, type: "data" }), "TAR-BYTES");
  });

  it("should keep parsing the log as json for the default export variant", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TExportEvent>({
      source: makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} })
    });

    const call = mock.callAt({ index: 0 });

    assert.ok(call.args.includes("rawjson"), call.args.join(" "));

    call.proc.stderr.end(`{"id":"step-1"}\n`);
    call.proc.stdout.end();
    call.proc.emit("close", 0);

    const collected = await events;
    const [first] = collected.filter((event) => {
      return event.type === "build-log";
    });

    assert.deepEqual(first.data, { id: "step-1" });
  });

  it("should use plain progress for the build behind runImageRaw", async () => {
    const mock = createSpawnMock();
    const events = collectEvents<TRawRunOutputEvent>({
      source: makeContext({ spawn: mock.spawn }).runImageRaw({
        environment: {},
        buildArgs: {}
      })
    });

    const buildCall = mock.callAt({ index: 0 });

    assert.ok(buildCall.args.includes("plain"), buildCall.args.join(" "));
    assert.ok(!buildCall.args.includes("rawjson"), buildCall.args.join(" "));

    writeImageId({ call: buildCall, imageId: "sha256:feedface" });
    buildCall.proc.stderr.end("#1 building\n");
    buildCall.proc.emit("close", 0);

    await mock.waitForCall({ index: 1 });
    completeRun({ call: mock.callAt({ index: 1 }), stdout: "ran" });

    const collected = await events;

    assert.equal(textOf({ events: collected, type: "build-log" }), "#1 building\n");
    assert.equal(textOf({ events: collected, type: "stdout" }), "ran");
  });

});

// Destroying is the consumer saying "I am done with this, whatever it was doing". The
// four blocks that follow walk through every stage a stream can be at when that happens,
// and each test asserts the same two things: the destroy completes on its own, and
// nothing docker was asked to do is still running afterwards.
describe("createDockerBuildContext / destroy while building", () => {

  it("should stop the build when destroyed before it produced anything", async () => {
    const mock = createSpawnMock();
    const context = createPassThrough();
    const duplex = makeContext({
      spawn: mock.spawn,
      createContext: providing({ context })
    }).runImage({ environment: {}, buildArgs: {} });

    await destroyAndWaitForClose({ target: duplex });

    assert.equal(mock.callCount(), 1, "no container may be started");
    assert.equal(mock.callAt({ index: 0 }).proc.killCount(), 1, "the build must be killed");
    assert.ok(context.destroyed, "the build context must be released");
    assertNothingLeftRunning({ mock });
  });

  it("should stop the build when destroyed halfway through the build log", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();

    const buildCall = mock.callAt({ index: 0 });

    buildCall.proc.stderr.write(`{"id":"step-1"}\n`);
    await settle();

    await destroyAndWaitForClose({ target: duplex });

    assert.equal(mock.callCount(), 1, "no container may be started");
    assertNothingLeftRunning({ mock });
  });

  it("should stop a build that is still being fed its context", async () => {
    const mock = createSpawnMock();
    const context = createPassThrough();
    const duplex = makeContext({
      spawn: mock.spawn,
      createContext: providing({ context })
    }).runImage({ environment: {}, buildArgs: {} });

    // the context is still open, so docker is mid-transfer when the consumer walks away
    context.write("half-a-tar");
    await settle();

    await destroyAndWaitForClose({ target: duplex });

    assert.ok(context.destroyed, "the build context must be released");
    assertNothingLeftRunning({ mock });
  });

  it("should remove the image id directory of a build it abandoned", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    const directory = imageIdDirectoryOf({ call: mock.callAt({ index: 0 }) });

    assert.ok(fs.existsSync(directory), "the build must have made one");

    await destroyAndWaitForClose({ target: duplex });

    assert.ok(!fs.existsSync(directory), "the abandoned build must not leave it behind");
    assertNothingLeftRunning({ mock });
  });

});

// Once the build is over it is the container, and only the container, that has to go.
describe("createDockerBuildContext / destroy while running", () => {

  it("should kill a container that was started while the stream was being destroyed", async () => {
    let duplex: stream.Duplex | undefined = undefined;

    const mock = createSpawnMock({
      onSpawn: ({ index }) => {
        // the narrowest window there is: the consumer gives up while docker run is being
        // created, before anything has had a chance to tie it to the stream
        if (index === 1) {
          duplex?.destroy();
        }
      }
    });

    duplex = makeContext({ spawn: mock.spawn }).runImage({ environment: {}, buildArgs: {} });
    duplex.once("error", () => {
      return undefined;
    });
    duplex.resume();

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    await settle();
    await settle();

    assert.equal(mock.callAt({ index: 1 }).proc.killCount(), 1, "the container must be killed");
    assertNothingLeftRunning({ mock });
  });

  it("should stop the container when destroyed before it produced anything", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();
    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });

    await destroyAndWaitForClose({ target: duplex });

    assert.equal(mock.callAt({ index: 1 }).proc.killCount(), 1, "the container must be killed");
    assertNothingLeftRunning({ mock });
  });

  it("should stop the container when destroyed halfway through its output", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();
    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    runCall.proc.stdout.write("half-the-output");
    await settle();

    await destroyAndWaitForClose({ target: duplex });

    assert.equal(runCall.proc.killCount(), 1, "the container must be killed");
    assertNothingLeftRunning({ mock });
  });

  it("should stop the container when destroyed while nothing is reading", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    // deliberately no reader: everything from the build on is sitting in the buffers
    completeBuild({ call: mock.callAt({ index: 0 }) });
    await settle();

    await destroyAndWaitForClose({ target: duplex });

    assertNothingLeftRunning({ mock });
  });

  it("should stop the container when destroyed while stdin is still open", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();
    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });

    // the writable half is still being used when the consumer gives up
    duplex.write({ type: "stdin", data: encoder.encode("still talking\n") });

    await destroyAndWaitForClose({ target: duplex });

    assert.equal(mock.callAt({ index: 1 }).proc.killCount(), 1, "the container must be killed");
    assertNothingLeftRunning({ mock });
  });

  it("should remove the container by name, not just kill the client", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();
    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });
    const containerName = containerNameOf({ call: runCall });

    assert.ok(containerName.startsWith("node-dockerfiler-"), containerName);

    await destroyAndWaitForClose({ target: duplex });

    // killing docker run leaves the container itself running, so it has to be named and
    // removed; the client dying is not enough
    await mock.waitForCall({ index: 2 });

    assert.deepEqual(mock.callAt({ index: 2 }).args, ["rm", "--force", containerName]);
    assertNothingLeftRunning({ mock });
  });

  it("should stop the container when destroyed with an error", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();
    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });

    const failed = new Promise<Error>((resolve) => {
      duplex.once("error", resolve);
    });

    await destroyAndWaitForClose({ target: duplex, error: Error("the consumer gave up") });

    assert.equal((await failed).message, "the consumer gave up");
    assert.equal(mock.callAt({ index: 1 }).proc.killCount(), 1, "the container must be killed");
    assertNothingLeftRunning({ mock });
  });

});

// A destroy that arrives once everything has already stopped stays a no-op: no stray
// signal, no second close, no throw.
describe("createDockerBuildContext / destroy with nothing left to stop", () => {

  it("should do nothing when destroyed after the run finished", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    const events = collectEvents<TRunOutputEvent>({ source: duplex });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    completeRun({ call: runCall, stdout: "all done" });

    assert.equal(textOf({ events: await events, type: "stdout" }), "all done");

    // the container exited on its own, so there is nothing left to signal
    await destroyAndWaitForClose({ target: duplex });

    assert.equal(runCall.proc.killCount(), 0, "an exited container must not be signalled");
    assertNothingLeftRunning({ mock });
  });

  it("should shrug off a cleanup command that cannot even be spawned", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();
    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    await destroyAndWaitForClose({ target: duplex });
    await mock.waitForCall({ index: 2 });

    // the stream is already gone, so a failing cleanup has nowhere to report to and must
    // not become an uncaught exception either
    mock.callAt({ index: 2 }).proc.emit("error", Error("docker rm: no such command"));

    await settle();
  });

  it("should not remove a container that already stopped on its own", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    const events = collectEvents<TRunOutputEvent>({ source: duplex });

    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    completeRun({ call: mock.callAt({ index: 1 }) });

    await events;
    await destroyAndWaitForClose({ target: duplex });

    // --rm already took care of it, so there is nothing to clean up after
    assert.equal(mock.callCount(), 2, "no cleanup command may be run");
    assertNothingLeftRunning({ mock });
  });

  it("should do nothing when destroyed twice", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    duplex.resume();
    completeBuild({ call: mock.callAt({ index: 0 }) });

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    await destroyAndWaitForClose({ target: duplex });
    await destroyAndWaitForClose({ target: duplex });

    assert.equal(runCall.proc.killCount(), 1, "the container must be signalled once");
    assertNothingLeftRunning({ mock });
  });

  it("should do nothing when destroyed after the build already failed", async () => {
    const mock = createSpawnMock();
    const duplex = makeContext({ spawn: mock.spawn }).runImage({
      environment: {},
      buildArgs: {}
    });

    const events = collectEvents<TRunOutputEvent>({ source: duplex });
    const buildCall = mock.callAt({ index: 0 });

    buildCall.proc.stderr.end();
    buildCall.proc.emit("close", 4);

    const { error } = await rejectionOf({ promise: events });

    assert.ok(error.message.includes("exited with code 4"), error.message);

    await destroyAndWaitForClose({ target: duplex });

    assert.equal(mock.callCount(), 1, "no container may be started");
    assertNothingLeftRunning({ mock });
  });

});

// The export stream has the same obligations, and neither it nor a run may be left
// running by a polite signal alone if docker refuses to act on it.
describe("createDockerBuildContext / destroy on an export, and stubborn processes", () => {

  it("should stop the export when destroyed halfway through the tar payload", async () => {
    const mock = createSpawnMock();
    const context = createPassThrough();
    const output = makeContext({
      spawn: mock.spawn,
      createContext: providing({ context })
    }).exportImageAsTarStream({ buildArgs: {} });

    output.resume();

    const call = mock.callAt({ index: 0 });

    call.proc.stderr.write(`{"id":"exporting"}\n`);
    call.proc.stdout.write("half-a-tar");
    await settle();

    await destroyAndWaitForClose({ target: output });

    assert.equal(call.proc.killCount(), 1, "docker must be killed");
    assert.ok(context.destroyed, "the build context must be released");
    assertNothingLeftRunning({ mock });
  });

  it("should do nothing when the export is destroyed after it finished", async () => {
    const mock = createSpawnMock();
    const output = makeContext({ spawn: mock.spawn }).exportImageAsTarStream({ buildArgs: {} });

    const events = collectEvents<TExportEvent>({ source: output });
    const call = mock.callAt({ index: 0 });

    call.proc.stderr.end();
    call.proc.stdout.end("TAR-BYTES");
    call.proc.emit("close", 0);

    assert.equal(textOf({ events: await events, type: "data" }), "TAR-BYTES");

    await destroyAndWaitForClose({ target: output });

    assert.equal(call.proc.killCount(), 0, "an exited process must not be signalled");
    assertNothingLeftRunning({ mock });
  });

  it("should escalate to SIGKILL when docker ignores the polite signal", async () => {
    const mock = createSpawnMock({ ignoresSigterm: true });
    const output = makeContext({
      spawn: mock.spawn,
      killGracePeriodMs: 10
    }).exportImageAsTarStream({ buildArgs: {} });

    output.resume();

    await destroyAndWaitForClose({ target: output });

    const { proc } = mock.callAt({ index: 0 });

    assert.deepEqual(proc.signalsSent(), ["SIGTERM"], "the polite signal comes first");

    await waitUntil({
      condition: () => {
        return proc.hasExited();
      }
    });

    assert.deepEqual(proc.signalsSent(), ["SIGTERM", "SIGKILL"]);
    assertNothingLeftRunning({ mock });
  });

  it("should escalate on a container that ignores the polite signal", async () => {
    const mock = createSpawnMock({ ignoresSigterm: true });
    const duplex = makeContext({
      spawn: mock.spawn,
      killGracePeriodMs: 10
    }).runImage({ environment: {}, buildArgs: {} });

    duplex.resume();

    // the build has to be allowed to finish, so it is the container that is left hanging
    const buildCall = mock.callAt({ index: 0 });

    writeImageId({ call: buildCall, imageId: "sha256:feedface" });
    buildCall.proc.stderr.end();
    buildCall.proc.emit("close", 0);

    await mock.waitForCall({ index: 1 });
    const runCall = mock.callAt({ index: 1 });

    await destroyAndWaitForClose({ target: duplex });

    await waitUntil({
      condition: () => {
        return runCall.proc.hasExited();
      }
    });

    assert.deepEqual(runCall.proc.signalsSent(), ["SIGTERM", "SIGKILL"]);
    assertNothingLeftRunning({ mock });
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
