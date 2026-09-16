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
  TRunInputEvent,
  TRawBuildLogEvent,
  TRawExportEvent,
  TRawRunOutputEvent
} from "./build-context.ts";

import {
  buildStreamToTar,
  buildStreamToFileInTar
} from "./stream-helper.ts";

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
  createContextTarStreamFromDirectory,
  buildStreamToTar,
  buildStreamToFileInTar
};

export type {
  TSpawn,
  TBuildLogEvent,
  TBuildEvent,
  TExportEvent,
  TRunOutputEvent,
  TRunInputEvent,
  TRawBuildLogEvent,
  TRawExportEvent,
  TRawRunOutputEvent
};
