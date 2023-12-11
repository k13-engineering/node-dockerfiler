/* global describe */
/* global it */

import dockerfiler from "../lib/index.js";

import assert from "assert";
import path from "path";
import stream from "stream";
import url from "url";
import tarStream from "tar-stream";

const scriptPath = url.fileURLToPath(import.meta.url);
const dirnameOfScript = path.dirname(scriptPath);

const dummySink = new stream.Writable({
  write () { }
});

describe("node-dockerfiler", function () {
  this.timeout(120 * 1000);

  it("should run Dockerfiles correctly", async () => {
    const dockerfileContent = `
      FROM debian:buster

      CMD echo Hello, World!
    `;

    const result = await dockerfiler.run({
      dockerfileContent,
      "context": path.resolve(dirnameOfScript),
      "logSink": dummySink
    });
    assert.equal(result.StatusCode, 0);
  });

  it("should forward error codes correctly", async () => {
    const dockerfileContent = `
      FROM debian:buster

      CMD cat /file-that-does-not-exist.txt
    `;

    const result = await dockerfiler.run({
      dockerfileContent,
      "context": path.resolve(dirnameOfScript, "context"),
      "logSink": dummySink
    });
    assert.equal(result.StatusCode, 1);
  });

  it("should support build contexts correctly", async () => {
    const dockerfileContent = `
      FROM debian:buster

      RUN mkdir -p /contenxt
      COPY . /context

      CMD cat /context/test.txt
    `;

    const result = await dockerfiler.run({
      dockerfileContent,
      "context": path.resolve(dirnameOfScript, "context"),
      "logSink": dummySink
    });
    assert.equal(result.StatusCode, 0);
  });

  it("should ignore files correctly", async () => {
    const dockerfileContent = `
      FROM debian:buster

      RUN mkdir -p /contenxt
      COPY . /context

      CMD cat /context/unwanted.txt
    `;

    const result = await dockerfiler.run({
      dockerfileContent,
      "context": path.resolve(dirnameOfScript, "context"),
      "ignore": (name) => {
        return name === "unwanted.txt";
      },
      "logSink": dummySink
    });
    assert.equal(result.StatusCode, 1);
  });

  it("should export images correctly", async () => {
    const dockerfileContent = `
      FROM debian:buster AS stage1
      RUN echo hello > /hello.txt

      FROM scratch
      COPY --from=stage1 /hello.txt /hello.txt
    `;

    const imageAsTar = dockerfiler.exportImage({
      dockerfileContent,
      "context": path.resolve(dirnameOfScript, "context"),
      "ignore": () => {
        return true;
      },
      "logSink": dummySink
    });

    const extractor = tarStream.extract();

    let fileList = [];

    extractor.on("entry", (header, entryStream, next) => {
      fileList = [
        ...fileList,
        header.name
      ];
      next();
    });

    await stream.promises.pipeline([
      imageAsTar,
      extractor
    ]);

    const helloTxtFound = fileList.includes("hello.txt");
    assert.ok(helloTxtFound);
  });
});
