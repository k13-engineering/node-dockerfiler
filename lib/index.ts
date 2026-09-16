import child_process from "node:child_process";
import type stream from "stream";

import {
  createDockerBuildContext,
  createContextTarStreamFromDirectory
} from "./build-context.ts";

import type {
  TSpawn,
  TBuildLogEvent,
  TBuildEvent,
  TExportEvent,
  TRunOutputEvent,
  TRunInputEvent
} from "./build-context.ts";

const createDefaultDockerBuildContext = ({
  createContextTarStream,
  platform
}: {
  createContextTarStream: () => stream.Readable,
  platform: string | undefined,
}) => {
  return createDockerBuildContext({
    createContextTarStream,
    platform,
    spawn: child_process.spawn
  });
};

export {
  createDefaultDockerBuildContext,
  createDockerBuildContext,
  createContextTarStreamFromDirectory
};

export type {
  TSpawn,
  TBuildLogEvent,
  TBuildEvent,
  TExportEvent,
  TRunOutputEvent,
  TRunInputEvent
};
