import process from "node:process";
import stream from "node:stream";

import {
  createDefaultDockerBuildContext,
  createContextTarStreamFromDirectory,
  buildStreamToFileInTar
} from "../lib/index.ts";

// Pulls a single file out of the built image without ever materialising the tar,
// while the build log goes to the terminal exactly as docker printed it.

const dockerfileContent = `
  FROM debian:bookworm-slim
  RUN echo "hello from inside the image" > /greeting.txt
`;

const context = createDefaultDockerBuildContext({
  createContextTarStream: () => {
    return createContextTarStreamFromDirectory({
      context: ".",
      dockerfileContent,
      ignore: undefined
    });
  },
  platform: undefined
});

await stream.promises.pipeline(
  context.exportImageAsTarStreamRaw({ buildArgs: {} }),
  buildStreamToFileInTar({ stderr: process.stderr, filePath: "greeting.txt" }),
  process.stdout
);
