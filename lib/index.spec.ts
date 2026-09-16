// pulls in the mocha describe/it globals without changing tsconfig.json
// eslint-disable-next-line spaced-comment
/// <reference types="mocha" />

import assert from "node:assert";

import { createDefaultDockerBuildContext, createContextTarStreamFromDirectory } from "./index.ts";

describe("createDefaultDockerBuildContext", () => {

  it("should expose the build context API without spawning anything", () => {
    const context = createDefaultDockerBuildContext({
      createContextTarStream: () => {
        return createContextTarStreamFromDirectory({
          context: ".",
          ignore: undefined,
          dockerfileContent: "FROM scratch\n"
        });
      },
      platform: undefined
    });

    assert.equal(typeof context.runImage, "function");
    assert.equal(typeof context.exportImageAsTarStream, "function");
  });

});
