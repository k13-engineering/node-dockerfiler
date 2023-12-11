import dockerfiler from "../lib/index.js";
import tarStream from "tar-stream";
import stream from "node:stream";

const dockerfileContent = `
  FROM debian:buster AS stage1
  RUN echo hello > /hello.txt

  FROM scratch
  COPY --from=stage1 /hello.txt /hello.txt
`;

const imageAsTar = dockerfiler.exportImage({
  dockerfileContent,
  // build context directory
  "context": "."
});

const extractor = tarStream.extract();

extractor.on("entry", (header, entryStream, next) => {
  console.log(header.name);
  next();
});

await stream.promises.pipeline([
  imageAsTar,
  extractor
]);
