import child_process from "node:child_process";
import type stream from "stream";

import {
  createDockerBuildContext,
  createContextTarStreamFromDirectory,
  createContextTarStreamFromFiles
} from "./build-context.ts";

import type {
  TContextFile,
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
  platform,
  // how long docker is given to stop on its own when a stream is destroyed, before the
  // process is killed outright; leaving it out keeps the default
  killGracePeriodMs
}: {
  createContextTarStream: () => stream.Readable,
  platform: string | undefined,
  killGracePeriodMs?: number | undefined,
}) => {
  return createDockerBuildContext({
    createContextTarStream,
    platform,
    killGracePeriodMs,
    spawn: child_process.spawn
  });
};

export {
  createDefaultDockerBuildContext,
  createDockerBuildContext,
  createContextTarStreamFromDirectory,
  createContextTarStreamFromFiles,
  buildStreamToTar,
  buildStreamToFileInTar
};

export type {
  TContextFile,
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
