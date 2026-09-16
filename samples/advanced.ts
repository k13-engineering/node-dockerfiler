import { once } from "node:events";
import process from "node:process";

import {
  createDefaultDockerBuildContext,
  createContextTarStreamFromDirectory
} from "../lib/index.ts";
import type { TRawRunOutputEvent } from "../lib/index.ts";

// Builds an image from a directory and runs it, showing the whole runImage surface:
// build arguments, environment, a build context filter, feeding the container on stdin,
// and demultiplexing the single stream it returns.

// the command to run is part of the image now, as CMD, rather than an option
const dockerfileContent = `
  FROM debian:bookworm-slim
  ARG GREETING=Hello
  COPY . /context
  RUN echo "$GREETING from the build" > /built.txt
  CMD ["/bin/sh", "-c", "cat /built.txt; echo Hello, $MYENV!; ls /context; cat; echo container finished 1>&2"]
`;

const context = createDefaultDockerBuildContext({
  createContextTarStream: () => {
    return createContextTarStreamFromDirectory({
      // the directory shipped to docker as the build context
      context: "samples",
      dockerfileContent,
      // decides what is left out of that context, by path relative to the directory above
      ignore: (name) => {
        return name.startsWith(".") || name.endsWith(".tar");
      }
    });
  },
  // undefined builds for the host architecture
  platform: undefined
});

const container = context.runImageRaw({
  // becomes docker run -e MYENV=World
  environment: { MYENV: "World" },
  // becomes docker buildx build --build-arg GREETING=Greetings
  buildArgs: { GREETING: "Greetings" }
});

// one stream carries everything, tagged by where it came from
container.on("data", (event: TRawRunOutputEvent) => {
  if (event.type === "stdout") {
    process.stdout.write(event.data);
    return;
  }

  // the build log and the container's own stderr both belong on stderr
  process.stderr.write(event.data);
});

// the writable half is the container's stdin; closing it lets `cat` finish
container.write({ type: "stdin", data: new TextEncoder().encode("hello from the host\n") });
container.end();

try {
  await once(container, "end");
} catch (ex) {
  process.stderr.write(`container failed: ${(ex as Error).message}\n`);
  // eslint-disable-next-line immutable/no-mutation
  process.exitCode = 1;
}
