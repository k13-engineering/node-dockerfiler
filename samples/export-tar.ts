import fs from "node:fs";
import process from "node:process";
import stream from "node:stream";

import {
  createDefaultDockerBuildContext,
  createContextTarStreamFromDirectory,
  buildStreamToTar
} from "../lib/index.ts";

// Writes the whole exported image to image.tar, while the build log goes to the
// terminal exactly as docker printed it.

const dockerfileContent = `
  FROM debian:bookworm-slim
  RUN echo "built at $(date)" > /built.txt
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
  buildStreamToTar({ stderr: process.stderr }),
  fs.createWriteStream("image.tar")
);

console.log("wrote image.tar");
