import fs from "node:fs";
import os from "node:os";
import path from "path";
import stream from "stream";

import tarFs from "tar-fs";
import type { Options } from "tar-fs";
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

type TBuildLogEvent = {
  type: "build-log";
  data: unknown;
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

const decoder = new TextDecoder();

// node does not expose O_TMPFILE, so it is composed from the linux fcntl.h definition
// O_TMPFILE = __O_TMPFILE | O_DIRECTORY, taking O_DIRECTORY from the platform constants.
const O_TMPFILE = 0o20000000 | fs.constants.O_DIRECTORY;

// A file that never has a name: the kernel creates an unnamed inode in the given
// directory's filesystem and reclaims it once the descriptor closes. Nothing is ever
// linked into the directory, so there is no path to collide with and nothing to clean up.
// The child reaches it through the inherited descriptor as /proc/self/fd/<n>.
const openAnonymousFile = () => {
  const fd = fs.openSync(os.tmpdir(), O_TMPFILE | fs.constants.O_RDWR, 0o600);

  return { fd };
};

const readFdAsText = ({ fd }: { fd: number }) => {
  const buffer = new Uint8Array(1024);
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);

  return decoder.decode(buffer.subarray(0, bytesRead)).trim();
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

const destroyOnError = ({
  target,
  sources
}: {
  target: stream.Duplex;
  sources: stream.Readable[];
}) => {
  sources.forEach((source) => {
    source.once("error", (err) => {
      target.destroy(err);
    });
  });
};

// A failing stdin (EPIPE, when docker stops reading the build context early) must never
// take the whole process down. The exit code decides whether the run actually failed.
const ignoreErrors = ({ target }: { target: stream.Writable }) => {
  target.once("error", () => {
    return undefined;
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

const createDockerBuildContext = ({
  createContextTarStream,
  platform,
  spawn
}: {
  createContextTarStream: () => stream.Readable,
  platform: string | undefined,
  spawn: TSpawn,
}) => {

  // The build is left untagged: buildkit reports the content addressed image id via
  // --iidfile, which is what gets run. That avoids inventing a throwaway image name
  // that would collide between concurrent runs.
  const buildImage = ({ buildArgs }: { buildArgs: { [key: string]: string; }; }) => {
    const { fd: imageIdFd } = openAnonymousFile();

    const proc = spawn("docker", [
      "buildx",
      "build", "-",
      ...(platform ? ["--platform", platform] : []),
      ...formatMapAsArgs({ flag: "--build-arg", values: buildArgs }),
      "--progress", "rawjson",
      "--iidfile", "/proc/self/fd/3"
    ], {
      stdio: ["pipe", "pipe", "pipe", imageIdFd]
    });

    const { stdin: procStdin, stderr: procStderr } = proc;

    if (procStdin === null || procStderr === null) {
      fs.closeSync(imageIdFd);
      throw Error(`docker build was spawned without the expected stdio pipes`);
    }

    const output = createObjectModeStream();

    const buildLog = pipeWithErrors({
      source: procStderr,
      stages: [
        JSONStream.parse(),
        createTaggingTransform({ type: "build-log", objectMode: true })
      ]
    });

    buildLog.pipe(output, { end: false });

    // built up front so that neither the stream end nor the process exit can be missed
    const finished = Promise.all([
      whenFinished({ source: buildLog }),
      whenExited({ proc })
    ]);

    ignoreErrors({ target: procStdin });
    createContextTarStream().pipe(procStdin);

    // the image id is emitted as the final message, once every build log has been forwarded
    const finish = async () => {
      try {
        const [, { code }] = await finished;

        if (code !== 0) {
          throw Error(`docker build exited with code ${code}`);
        }

        const imageId = readFdAsText({ fd: imageIdFd });

        if (imageId === "") {
          throw Error(`docker build did not report an image id`);
        }

        output.write({ type: "image-id", data: imageId });
        output.end();
      } finally {
        fs.closeSync(imageIdFd);
      }
    };

    finish().catch((err: Error) => {
      output.destroy(err);
    });

    return output;
  };

  const runImage = ({
    environment,
    buildArgs
  }: {
    environment: { [key: string]: string; } | undefined;
    buildArgs: { [key: string]: string; };
  }) => {
    const output = createObjectModeStream();
    const stdinInput = createStdinTransform();

    const startContainer = ({ imageId }: { imageId: string }) => {
      const proc = spawn("docker", [
        "run",
        "-i",
        ...formatMapAsArgs({ flag: "-e", values: environment }),
        imageId
      ], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      ignoreErrors({ target: proc.stdin });
      stdinInput.pipe(proc.stdin);

      destroyOnError({ target: output, sources: [proc.stdout, proc.stderr] });

      proc.stdout
        .pipe(createTaggingTransform({ type: "stdout", objectMode: false }))
        .pipe(output, { end: false });

      proc.stderr
        .pipe(createTaggingTransform({ type: "stderr", objectMode: false }))
        .pipe(output, { end: false });

      proc.on("error", (err) => {
        output.destroy(err);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          output.destroy(Error(`docker run exited with code ${code}`));
          return;
        }

        output.end();
      });
    };

    const work = async () => {
      const buildEvents = buildImage({ buildArgs });

      let imageId = "";

      buildEvents.on("data", (event: TBuildEvent) => {
        if (event.type === "image-id") {
          imageId = event.data;
          return;
        }

        output.write(event);
      });

      const { buildError } = await new Promise<{ buildError: Error | undefined }>((resolve) => {
        buildEvents.once("end", () => {
          resolve({ buildError: undefined });
        });

        buildEvents.once("error", (err) => {
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

  const exportImageAsTarStream = ({
    buildArgs
  }: {
    buildArgs: { [key: string]: string; };
  }) => {
    const proc = spawn("docker", [
      "buildx",
      "build", "-",
      ...(platform ? ["--platform", platform] : []),
      ...formatMapAsArgs({ flag: "--build-arg", values: buildArgs }),
      "--output", "type=tar",
      "--progress", "rawjson"
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const output = createObjectModeStream();

    const buildLog = pipeWithErrors({
      source: proc.stderr,
      stages: [
        JSONStream.parse(),
        createTaggingTransform({ type: "build-log", objectMode: true })
      ]
    });

    const imageAsTarStream = pipeWithErrors({
      source: proc.stdout,
      stages: [createTaggingTransform({ type: "data", objectMode: false })]
    });

    buildLog.pipe(output, { end: false });
    imageAsTarStream.pipe(output, { end: false });

    const finished = Promise.all([
      whenFinished({ source: buildLog }),
      whenFinished({ source: imageAsTarStream }),
      whenExited({ proc })
    ]);

    ignoreErrors({ target: proc.stdin });
    createContextTarStream().pipe(proc.stdin);

    const finish = async () => {
      const [, , { code }] = await finished;

      if (code !== 0) {
        throw Error(`docker build exited with code ${code}`);
      }

      output.end();
    };

    finish().catch((err: Error) => {
      output.destroy(err);
    });

    return output;
  };

  return {
    runImage,
    exportImageAsTarStream
  };
};

export {
  createDockerBuildContext,
  createContextTarStreamFromDirectory
};

export type {
  TSpawn,
  TBuildLogEvent,
  TBuildEvent,
  TExportEvent,
  TRunOutputEvent,
  TRunInputEvent
};
