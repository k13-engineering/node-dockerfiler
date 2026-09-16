import { create, createContextTarStreamFromDirectory } from "../lib/index.ts";

const dockerfileContent = `
  FROM debian:buster
  CMD echo Hello, World!
`;

const d = create({
  createContextTarStream: () => {
    return createContextTarStreamFromDirectory({
      context: ".",
      dockerfileContent,
      ignore: undefined
    });
  },
  platform: undefined
});

const { imageAsTarStream, log } = d.exportImageAsTarStream();

log.on("data", (data) => {
  console.log("log", data);
});

imageAsTarStream.on("data", (data) => {
  console.log("imageAsTarStream", data);
});
