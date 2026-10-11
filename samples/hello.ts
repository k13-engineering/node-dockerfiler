import {
  createDefaultDockerBuildContext,
  createContextTarStreamFromDirectory
} from "../lib/index.ts";
import type { TExportEvent } from "../lib/index.ts";

const dockerfileContent = `
  FROM debian:buster
  CMD echo Hello, World!
`;

const d = createDefaultDockerBuildContext({
  createContextTarStream: () => {
    return createContextTarStreamFromDirectory({
      context: ".",
      dockerfileContent,
      ignore: undefined
    });
  },
  platform: undefined
});

const events = d.exportImageAsTarStream({
  buildArgs: {}
});

events.on("data", (event: TExportEvent) => {
  if (event.type === "build-log") {
    console.log("build-log", event.data);
    return;
  }

  console.log("data", event.data.length);
});
