import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import stream from "stream";
import { setTimeout, clearTimeout } from "node:timers";

import tarFs from "tar-fs";
import type { Options } from "tar-fs";
import tarStream from "tar-stream";
import type * as child_process from "node:child_process";
// @ts-expect-error missing types
import JSONStream from "JSONStream";

type TSpawn = typeof child_process.spawn;
type TChildProcess = child_process.ChildProcess;

const createObjectModeStream = () => {
  // eslint-disable-next-line k13-engineering/no-new
  return new stream.PassThrough({ objectMode: true });
};

const formatMapAsArgs = ({
  flag,
  values
}: {
  flag: string;
  values: { [key: string]: string; } | undefined;
}): string[] => {
  if (values === undefined) {
    return [];
  }

  return Object.keys(values).flatMap((key) => {
    return [flag, `${key}=${values[key]}`];
  });
};

// with --progress rawjson the log is parsed into buildkit's progress records, with
// --progress plain it stays the raw bytes docker wrote, ready to forward to a terminal
type TBuildLogEvent = {
  type: "build-log";
  data: unknown;
};

type TRawBuildLogEvent = {
  type: "build-log";
  data: Uint8Array;
};

type TRawExportEvent = TRawBuildLogEvent | {
  type: "data";
  data: Uint8Array;
};

type TRawRunOutputEvent = TRawBuildLogEvent | {
  type: "stdout";
  data: Uint8Array;
} | {
  type: "stderr";
  data: Uint8Array;
};

type TBuildEvent = TBuildLogEvent | {
  type: "image-id";
  data: string;
};

type TExportEvent = TBuildLogEvent | {
  type: "data";
  data: Uint8Array;
};

type TRunOutputEvent = TBuildLogEvent | {
  type: "stdout";
  data: Uint8Array;
} | {
  type: "stderr";
  data: Uint8Array;
};

type TRunInputEvent = {
  type: "stdin";
  data: Uint8Array;
};

const createTaggingTransform = ({
  type,
  objectMode
}: {
  type: TExportEvent["type"] | TRunOutputEvent["type"];
  objectMode: boolean;
}) => {
  // eslint-disable-next-line k13-engineering/no-new
  return new stream.Transform({
    writableObjectMode: objectMode,
    readableObjectMode: true,
    // the (chunk, encoding, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    transform: (data, encoding, callback) => {
      callback(null, { type, data });
    }
  });
};

const createStdinTransform = () => {
  // eslint-disable-next-line k13-engineering/no-new
  return new stream.Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    // the (chunk, encoding, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    transform: (event: TRunInputEvent, encoding, callback) => {
      if (event.type !== "stdin") {
        callback();
        return;
      }

      callback(null, event.data);
    }
  });
};

// rawjson needs the buildkit records parsed out of the stream, plain progress is passed
// through untouched so it can be written straight to a terminal
const createBuildLogStages = ({ rawLog }: { rawLog: boolean }): stream.Duplex[] => {
  if (rawLog) {
    return [createTaggingTransform({ type: "build-log", objectMode: false })];
  }

  return [
    JSONStream.parse(),
    createTaggingTransform({ type: "build-log", objectMode: true })
  ];
};

const progressForLog = ({ rawLog }: { rawLog: boolean }) => {
  return rawLog ? "plain" : "rawjson";
};

// buildx unlinks the --iidfile path and creates it afresh before writing the image id,
// so it has to be a real, removable directory entry. Handing it an already open
// descriptor as /proc/self/fd/<n> fails with EPERM: such an entry cannot be unlinked.
// The file lives in a directory of its own, which is removed once the id has been read.
const createImageIdFile = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-dockerfiler-"));
  const filePath = path.join(directory, "iid");

  const read = () => {
    if (!fs.existsSync(filePath)) {
      return "";
    }

    return fs.readFileSync(filePath, "utf-8").trim();
  };

  const cleanup = () => {
    fs.rmSync(directory, { recursive: true, force: true });
  };

  return { filePath, read, cleanup };
};

// Errors do not travel across .pipe(), and intermediate stages such as JSONStream are
// old style streams whose destroy() emits nothing. Every upstream failure is therefore
// forwarded straight to the last stage, so a failure anywhere is observable at the end.
const pipeWithErrors = ({
  source,
  stages
}: {
  source: stream.Readable;
  stages: stream.Duplex[];
}): stream.Readable => {
  const terminal = stages.reduce((current: stream.Readable, stage) => {
    return current.pipe(stage);
  }, source);

  const upstream: stream.Readable[] = [source, ...stages.slice(0, -1)];

  upstream.forEach((current) => {
    current.once("error", (err: Error) => {
      terminal.destroy(err);
    });
  });

  return terminal;
};

const whenFinished = ({ source }: { source: stream.Readable }) => {
  return new Promise<void>((resolve, reject) => {
    source.once("end", () => {
      resolve();
    });

    source.once("error", reject);
  });
};

const whenExited = ({ proc }: { proc: TChildProcess }) => {
  return new Promise<{ code: number | null }>((resolve, reject) => {
    proc.once("close", (code) => {
      resolve({ code });
    });

    proc.once("error", reject);
  });
};

// Deliberately independent of the output streams draining: a non zero exit has to fail
// the stream even if the process left its stdio open, so a failure can never hang.
const whenExitedSuccessfully = async ({
  proc,
  action
}: {
  proc: TChildProcess;
  action: string;
}) => {
  const { code } = await whenExited({ proc });

  if (code !== 0) {
    throw Error(`${action} exited with code ${code}`);
  }
};

// A failing stdin (EPIPE, when docker stops reading the build context early) must never
// take the whole process down. The exit code decides whether the run actually failed.
const ignoreErrors = ({ target }: { target: stream.Writable }) => {
  target.once("error", () => {
    return undefined;
  });
};

// .pipe() never listens on its source, so an error there would be an uncaught exception.
// The caller supplied context stream is such a source.
const failOnError = ({
  output,
  source
}: {
  output: stream.Duplex;
  source: stream.Readable;
}) => {
  source.once("error", (err: Error) => {
    output.destroy(err);
  });
};

// How long a docker process is given to wind down on its own after SIGTERM, before it is
// taken down the hard way.
const defaultKillGracePeriodMs = 5000;

// SIGTERM first, because that is what docker acts on: buildx cancels the build it is
// running rather than leaving it half done. A process that ignores the signal would
// outlive the stream it serves, so the kill escalates to SIGKILL once the grace period is
// up. The escalation timer is unref'd, so waiting for a process to die can never be the
// reason the host process stays alive, and it is cleared as soon as the process is gone.
// Reports whether a live process was signalled at all, which tells the caller whether
// anything may still be left behind.
const stopProcess = ({
  proc,
  killGracePeriodMs
}: {
  proc: TChildProcess;
  killGracePeriodMs: number;
}): boolean => {
  let exited = false;

  proc.once("close", () => {
    exited = true;
  });

  // false means the signal could not be delivered, which for an already exited process is
  // the normal case: there is then nothing left to escalate against
  const signalled = proc.kill("SIGTERM");

  if (!signalled || exited) {
    return signalled;
  }

  const escalation = setTimeout(() => {
    proc.kill("SIGKILL");
  }, killGracePeriodMs);

  escalation.unref();

  proc.once("close", () => {
    clearTimeout(escalation);
  });

  return true;
};

// Stopping the docker run client does not stop what it started. The client dies with the
// signal rather than passing it on, and even when it does pass it on, a container's PID 1
// ignores a signal it has installed no handler for, which is the usual case for a CMD.
// The container would then keep running with nothing attached to it, so it is removed
// outright, by the name every run is given for exactly this purpose.
const removeContainer = ({
  spawn,
  containerName
}: {
  spawn: TSpawn;
  containerName: string;
}) => {
  const remover = spawn("docker", ["rm", "--force", containerName], { stdio: "ignore" });

  // a container that stopped on its own is already gone, which makes this fail. There is
  // nothing to report either way, and nothing may be left waiting on it.
  remover.once("error", () => {
    return undefined;
  });

  remover.unref();
};

// Whatever closes the output, an error, the consumer giving up or a normal end, must
// also stop what feeds it: neither the docker process nor the context still being
// streamed into it may outlive the stream they serve.
const stopFeedersOnClose = ({
  output,
  proc,
  context,
  killGracePeriodMs,
  removeLeftovers
}: {
  output: stream.Readable;
  proc: TChildProcess;
  context: stream.Readable | undefined;
  killGracePeriodMs: number;
  removeLeftovers: (() => void) | undefined;
}) => {
  output.once("close", () => {
    context?.destroy();

    const signalled = stopProcess({ proc, killGracePeriodMs });

    // nothing to signal means the process had already finished on its own, and with --rm
    // it took its container with it
    if (signalled) {
      removeLeftovers?.();
    }
  });
};

// node's Duplex.from({ readable, writable }) supports node streams at runtime, but
// @types/node only declares the web stream pair form, so the duplex is built by hand.
const createDuplexFrom = ({
  input,
  output
}: {
  input: stream.Writable;
  output: stream.Readable;
}) => {
  // eslint-disable-next-line k13-engineering/no-new
  const duplex = new stream.Duplex({
    objectMode: true,
    read: () => {
      output.resume();
    },
    // the (chunk, encoding, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    write: (event, encoding, callback) => {
      input.write(event, callback);
    },
    final: (callback) => {
      input.end();
      callback();
    },
    // a consumer that gives up on the duplex must take both underlying streams with it
    // the (error, callback) signature is imposed by node's stream API
    // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
    destroy: (err, callback) => {
      output.destroy();
      input.destroy();
      callback(err);
    }
  });

  output.on("data", (event) => {
    // push here is the Readable stream API, not an array mutation
    // eslint-disable-next-line fp/no-mutating-methods
    if (!duplex.push(event)) {
      output.pause();
    }
  });

  output.once("end", () => {
    // push here is the Readable stream API, not an array mutation
    // eslint-disable-next-line fp/no-mutating-methods
    duplex.push(null);
  });

  output.once("error", (err) => {
    duplex.destroy(err);
  });

  return duplex;
};

const createContextTarStreamFromDirectory = ({
  context,
  ignore: userIgnore,
  dockerfileContent
}: {
  context: string;
  ignore: Options["ignore"];
  dockerfileContent: string;
}) => {
  let ignore: Options["ignore"] = undefined;

  if (userIgnore) {
    ignore = (name) => {
      return userIgnore(path.relative(context, name));
    };
  }

  const pack = tarFs.pack(context, {
    finalize: false,
    ignore,
    finish: () => {
      pack.entry({ name: "Dockerfile" }, dockerfileContent);
      pack.finalize();
    }
  });

  return pack as unknown as stream.Readable;
};

// A file the caller has already got in hand, rather than one to be read from a directory.
// There is no owner and no timestamp: nothing was taken from a filesystem that could have
// carried them, and leaving them out is what makes the context reproducible.
type TContextFile = {
  content: Uint8Array;
  mode: bigint;
};

const contextFileEpoch = new Date(0);

const createContextTarStreamFromFiles = ({
  files,
  dockerfileContent
}: {
  files: { [path: string]: TContextFile };
  dockerfileContent: string;
}) => {
  const pack = tarStream.pack();

  // written through the entry's own stream rather than handed over as one block, which
  // keeps the content a Uint8Array. tar-stream only derives the size from a whole block,
  // so it has to be stated here.
  const addEntry = ({
    name,
    mode,
    content
  }: {
    name: string;
    mode: number;
    content: Uint8Array;
  }) => {
    const entry = pack.entry({
      name,
      mode,
      uid: 0,
      gid: 0,
      mtime: contextFileEpoch,
      size: content.byteLength
    });

    entry.end(content);
  };

  Object.keys(files).forEach((name) => {
    const file = files[name];

    addEntry({ name, mode: Number(file.mode), content: file.content });
  });

  addEntry({
    name: "Dockerfile",
    mode: 0o644,
    content: new TextEncoder().encode(dockerfileContent)
  });

  pack.finalize();

  return pack as unknown as stream.Readable;
};

const createDockerBuildContext = ({
  createContextTarStream,
  platform,
  spawn,
  killGracePeriodMs = defaultKillGracePeriodMs
}: {
  createContextTarStream: () => stream.Readable,
  platform: string | undefined,
  spawn: TSpawn,
  killGracePeriodMs?: number | undefined,
}) => {

  // Every build streams the context in the same way, and ties both the process and the
  // context to the lifetime of the output stream.
  const feedContext = ({
    output,
    proc,
    stdin
  }: {
    output: stream.Duplex;
    proc: TChildProcess;
    stdin: stream.Writable;
  }) => {
    const context = createContextTarStream();

    ignoreErrors({ target: stdin });
    failOnError({ output, source: context });
    stopFeedersOnClose({ output, proc, context, killGracePeriodMs, removeLeftovers: undefined });
    context.pipe(stdin);
  };

  // The build is left untagged: buildkit reports the content addressed image id via
  // --iidfile, which is what gets run. That avoids inventing a throwaway image name
  // that would collide between concurrent runs.
  const spawnBuild = ({
    buildArgs,
    imageIdPath,
    rawLog
  }: {
    buildArgs: { [key: string]: string; };
    imageIdPath: string;
    rawLog: boolean;
  }) => {
    return spawn("docker", [
      "buildx",
      "build", "-",
      ...(platform ? ["--platform", platform] : []),
      ...formatMapAsArgs({ flag: "--build-arg", values: buildArgs }),
      "--progress", progressForLog({ rawLog }),
      "--iidfile", imageIdPath
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });
  };

  const buildImage = ({
    buildArgs,
    rawLog
  }: {
    buildArgs: { [key: string]: string; };
    rawLog: boolean;
  }) => {
    const imageIdFile = createImageIdFile();
    const proc = spawnBuild({ buildArgs, imageIdPath: imageIdFile.filePath, rawLog });

    const output = createObjectModeStream();

    const buildLog = pipeWithErrors({
      source: proc.stderr,
      stages: createBuildLogStages({ rawLog })
    });

    buildLog.pipe(output, { end: false });

    // built up front so that neither the stream end nor the process exit can be missed
    const drained = whenFinished({ source: buildLog });
    const exitedOk = whenExitedSuccessfully({ proc, action: "docker build" });

    feedContext({ output, proc, stdin: proc.stdin });

    // the image id is emitted as the final message, once every build log has been forwarded
    const finish = async () => {
      try {
        await Promise.all([drained, exitedOk]);

        const imageId = imageIdFile.read();

        if (imageId === "") {
          throw Error(`docker build did not report an image id`);
        }

        output.write({ type: "image-id", data: imageId });
        output.end();
      } finally {
        imageIdFile.cleanup();
      }
    };

    finish().catch((err: Error) => {
      output.destroy(err);
    });

    return output;
  };

  const startRun = ({
    environment,
    buildArgs,
    rawLog
  }: {
    environment: { [key: string]: string; } | undefined;
    buildArgs: { [key: string]: string; };
    rawLog: boolean;
  }) => {
    const output = createObjectModeStream();
    const stdinInput = createStdinTransform();

    const startContainer = ({ imageId }: { imageId: string }) => {
      // --rm so a container that stops on its own is gone with it, and a name so that one
      // that does not can still be removed after the client it was started by is dead
      const containerName = `node-dockerfiler-${randomUUID()}`;

      const proc = spawn("docker", [
        "run",
        "--rm",
        "--name", containerName,
        "-i",
        ...formatMapAsArgs({ flag: "-e", values: environment }),
        imageId
      ], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      ignoreErrors({ target: proc.stdin });

      stopFeedersOnClose({
        output,
        proc,
        context: undefined,
        killGracePeriodMs,
        removeLeftovers: () => {
          removeContainer({ spawn, containerName });
        }
      });
      stdinInput.pipe(proc.stdin);

      const stdoutEvents = pipeWithErrors({
        source: proc.stdout,
        stages: [createTaggingTransform({ type: "stdout", objectMode: false })]
      });

      const stderrEvents = pipeWithErrors({
        source: proc.stderr,
        stages: [createTaggingTransform({ type: "stderr", objectMode: false })]
      });

      stdoutEvents.pipe(output, { end: false });
      stderrEvents.pipe(output, { end: false });

      const drained = Promise.all([
        whenFinished({ source: stdoutEvents }),
        whenFinished({ source: stderrEvents })
      ]);

      const exitedOk = whenExitedSuccessfully({ proc, action: "docker run" });

      const finish = async () => {
        await Promise.all([drained, exitedOk]);

        output.end();
      };

      finish().catch((err: Error) => {
        output.destroy(err);
      });
    };

    const work = async () => {
      const buildEvents = buildImage({ buildArgs, rawLog });

      // a run stream closed while the build is still going takes the build down with it
      output.once("close", () => {
        buildEvents.destroy(Error(`docker build abandoned, its run stream was closed`));
      });

      let imageId = "";

      // piping rather than forwarding by hand, so a slow consumer backpressures the build
      // eslint-disable-next-line k13-engineering/no-new
      const captureImageId = new stream.Transform({
        objectMode: true,
        // the (chunk, encoding, callback) signature is imposed by node's stream API
        // eslint-disable-next-line k13-engineering/prefer-single-object-parameters
        transform: (event: TBuildEvent, encoding, callback) => {
          if (event.type === "image-id") {
            imageId = event.data;
            callback();
            return;
          }

          callback(null, event);
        }
      });

      const buildLogs = pipeWithErrors({ source: buildEvents, stages: [captureImageId] });

      buildLogs.pipe(output, { end: false });

      const { buildError } = await new Promise<{ buildError: Error | undefined }>((resolve) => {
        buildLogs.once("end", () => {
          resolve({ buildError: undefined });
        });

        buildLogs.once("error", (err) => {
          resolve({ buildError: err });
        });
      });

      if (buildError !== undefined) {
        output.destroy(buildError);
        return;
      }

      startContainer({ imageId });
    };

    // buildImage can throw synchronously, so the failure has to land on the stream too
    work().catch((err: Error) => {
      output.destroy(err);
    });

    return createDuplexFrom({
      input: stdinInput,
      output
    });
  };

  const startExport = ({
    buildArgs,
    rawLog
  }: {
    buildArgs: { [key: string]: string; };
    rawLog: boolean;
  }) => {
    const proc = spawn("docker", [
      "buildx",
      "build", "-",
      ...(platform ? ["--platform", platform] : []),
      ...formatMapAsArgs({ flag: "--build-arg", values: buildArgs }),
      "--output", "type=tar",
      "--progress", progressForLog({ rawLog })
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const output = createObjectModeStream();

    const buildLog = pipeWithErrors({
      source: proc.stderr,
      stages: createBuildLogStages({ rawLog })
    });

    const imageAsTarStream = pipeWithErrors({
      source: proc.stdout,
      stages: [createTaggingTransform({ type: "data", objectMode: false })]
    });

    buildLog.pipe(output, { end: false });
    imageAsTarStream.pipe(output, { end: false });

    const drained = Promise.all([
      whenFinished({ source: buildLog }),
      whenFinished({ source: imageAsTarStream })
    ]);

    const exitedOk = whenExitedSuccessfully({ proc, action: "docker build" });

    feedContext({ output, proc, stdin: proc.stdin });

    const finish = async () => {
      await Promise.all([drained, exitedOk]);

      output.end();
    };

    finish().catch((err: Error) => {
      output.destroy(err);
    });

    return output;
  };

  type TRunOptions = {
    environment: { [key: string]: string; } | undefined;
    buildArgs: { [key: string]: string; };
  };

  type TExportOptions = {
    buildArgs: { [key: string]: string; };
  };

  const runImage = ({ environment, buildArgs }: TRunOptions) => {
    return startRun({ environment, buildArgs, rawLog: false });
  };

  const runImageRaw = ({ environment, buildArgs }: TRunOptions) => {
    return startRun({ environment, buildArgs, rawLog: true });
  };

  const exportImageAsTarStream = ({ buildArgs }: TExportOptions) => {
    return startExport({ buildArgs, rawLog: false });
  };

  const exportImageAsTarStreamRaw = ({ buildArgs }: TExportOptions) => {
    return startExport({ buildArgs, rawLog: true });
  };

  return {
    runImage,
    runImageRaw,
    exportImageAsTarStream,
    exportImageAsTarStreamRaw
  };
};

export {
  createDockerBuildContext,
  createContextTarStreamFromDirectory,
  createContextTarStreamFromFiles
};

export type {
  TContextFile,
  TSpawn,
  TBuildLogEvent,
  TBuildEvent,
  TExportEvent,
  TRunOutputEvent,
  TRunInputEvent,
  TRawBuildLogEvent,
  TRawExportEvent,
  TRawRunOutputEvent
};
