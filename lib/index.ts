import path from "path";
import stream from "stream";

import tarFs from "tar-fs";
import type { Options } from "tar-fs";
import child_process from "node:child_process";
// @ts-expect-error missing types
import JSONStream from "JSONStream";

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
    "finalize": false,
    ignore,
    "finish": () => {
      pack.entry({ "name": "Dockerfile" }, dockerfileContent);
      pack.finalize();
    }
  });

  return pack as unknown as stream.Readable;
};

const create = ({
  createContextTarStream,
  platform
}: {
  createContextTarStream: () => stream.Readable,
  platform: string | undefined,
}) => {

  const buildImage = ({ tagName }: { tagName: string }) => {
    const proc = child_process.spawn("docker", [
      "buildx",
      "build", "-",
      ...(platform ? ["--platform", platform] : []),
      "--progress", "rawjson",
      "--tag", tagName
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const log = new stream.PassThrough({ objectMode: true });
    proc.stderr.pipe(JSONStream.parse()).pipe(log);

    const contextAsTarStream = createContextTarStream();

    contextAsTarStream.pipe(proc.stdin);

    return {
      log
    };
  };

  const runImage = ({
    environment
  }: {
    environment: { [key: string]: string; }
  }) => {
    let environmentArgs: string[] = [];

    const log = new stream.PassThrough({ objectMode: true });

    const work = async () => {
      const { log: buildLog } = buildImage({ tagName: "temp" });

      buildLog.pipe(log, { end: false });

      const { buildError } = await new Promise<{ buildError: Error | undefined }>((resolve) => {
        buildLog.once("end", () => {
          resolve({ buildError: undefined });
        });
        buildLog.once("error", (err) => {
          resolve({ buildError: err });
        });
      });

      if (buildError !== undefined) {
        log.destroy(buildError);
        return;
      }

      Object.keys(environment).forEach((key) => {
        environmentArgs = [
          ...environmentArgs,
          "-e",
          `${key}=${environment[key]}`
        ];
      });

      const proc = child_process.spawn("docker", [
        "run",
        ...environmentArgs,
        "temp"
      ], {
        stdio: ["ignore", "pipe", "pipe"]
      });

      proc.stdout.pipe(log, { end: false });
      proc.stderr.pipe(log, { end: false });

      proc.on("error", (err) => {
        log.destroy(err);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          log.destroy(new Error(`docker run exited with code ${code}`));
          return;
        }
        log.end();
      });
    };

    work();

    return {
      log
    };
  };

  const exportImageAsTarStream = () => {

    const contextAsTarStream = createContextTarStream();

    const proc = child_process.spawn("docker", [
      "buildx",
      "build", "-",
      ...(platform ? ["--platform", platform] : []),
      "--output", "type=tar",
      "--progress", "rawjson"
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const imageAsTarStream = proc.stdout;

    const log = new stream.PassThrough({ objectMode: true });
    proc.stderr.pipe(JSONStream.parse()).pipe(log);

    contextAsTarStream.pipe(proc.stdin);

    return {
      imageAsTarStream,
      log
    };
  };

  return {
    exportImageAsTarStream
  };
};

export {
  create,
  createContextTarStreamFromDirectory
};
