/* global describe */
/* global it */

import dockerfiler from "../lib/index.js";

import assert from "assert";
import path from "path";
import stream from "stream";
import url from "url";

const scriptPath = url.fileURLToPath(import.meta.url);
const dirnameOfScript = path.dirname(scriptPath);

const dummySink = new stream.Writable({
  write () {}
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
});
