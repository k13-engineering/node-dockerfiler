import crypto from "crypto";
import path from "path";
import stream from "stream";

import Docker from "dockerode";
import tarFs from "tar-fs";

const createTarFile = ({ context, "ignore": userIgnore, dockerfileContent }) => {
  let ignore = undefined;

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

  return pack;
};

const generateUniqueId = () => {
  return crypto.randomBytes(16).toString("hex");
};

const buildImage = async ({ docker, dockerfileContent, context, ignore, tagName, logSink }) => {
  const tarFileStream = createTarFile({ context, ignore, dockerfileContent });
  const buildStream = await docker.buildImage(tarFileStream, {
    "t": tagName
  });

  return new Promise((resolve, reject) => {
    buildStream.on("data", (data) => {
      const raw = data.toString("utf8");
      const parsed = JSON.parse(raw);
      if (parsed.error) {
        reject(new Error(parsed.error));
      } else if (parsed.stream) {
        logSink.write(parsed.stream);
      }
    });

    buildStream.on("end", () => {
      resolve();
    });
  });
};

const runImage = async ({ docker, tagName, command, options, logSink }) => {
  const forwarder = new stream.Writable({
    write (...args) {
      logSink.write(...args);
    }
  });
  return await docker.run(tagName, command, forwarder, options);
};

const run = async ({
  dockerfileContent,
  context = ".",
  ignore,
  command,
  options,
  logSink = process.stdout
}) => {
  const docker = new Docker();

  const tagName = `dockerfiler/${generateUniqueId()}`;

  await buildImage({ docker, dockerfileContent, context, ignore, tagName, logSink });
  const [output, container] = await runImage({ docker, tagName, command, options, logSink });
  await container.remove();

  return output;
};

const exportImage = ({
  dockerfileContent,
  context = ".",
  ignore,
  options,
  logSink = process.stdout
}) => {
  const output = new stream.PassThrough();

  const docker = new Docker();

  const tagName = `dockerfiler/${generateUniqueId()}`;

  const build = async () => {
    try {
      await buildImage({ docker, dockerfileContent, context, ignore, tagName, logSink });

      const container = await docker.createContainer({
        "Image": tagName,
        "Cmd": ["true"]
      });

      const containerAsTarStream = await container.export(options);

      containerAsTarStream.pipe(output, { "end": false });
      containerAsTarStream.on("error", (error) => {
        output.emit("error", error);
      });
      containerAsTarStream.on("end", async () => {
        // remove container after export
        // but do so before ending the output stream

        try {
          await container.remove();
        } catch (ex2) {
          output.emit("error", ex2);
          return;
        }

        output.end();
      });
    } catch (ex) {
      output.emit("error", ex);
    }
  };

  setTimeout(() => {
    build();
  }, 0);

  return output;
};

export default {
  run,
  exportImage
};
