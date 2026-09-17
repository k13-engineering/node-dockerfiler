import child_process from "node:child_process";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

import {
  createDockerBuildContext,
  createContextTarStreamFromDirectory
} from "../lib/index.ts";
import type { TSpawn, TRawRunOutputEvent } from "../lib/index.ts";

// Destroying the stream is how a consumer says "I am done with this, whatever it was
// doing". Whatever docker was doing for it, a build or a container that would otherwise
// run forever, has to stop with it.
//
// This sample proves that rather than claiming it: it wraps the spawn the library uses so
// it can keep the process id of every docker it starts, destroys the stream halfway
// through an endless container, and then checks that none of those processes is left.

const dockerfileContent = `
  FROM debian:bookworm-slim
  CMD ["/bin/sh", "-c", "while true; do echo tick; sleep 1; done"]
`;

let startedPids: number[] = [];

// exactly what createDefaultDockerBuildContext uses, with a note taken of what it starts
// the positional signature is the one child_process.spawn imposes
// eslint-disable-next-line k13-engineering/prefer-single-object-parameters
const spawn = ((
  command: string,
  args: readonly string[],
  options: child_process.SpawnOptions
) => {
  const proc = child_process.spawn(command, args, options);

  if (proc.pid !== undefined) {
    startedPids = [...startedPids, proc.pid];
  }

  return proc;
}) as unknown as TSpawn;

const context = createDockerBuildContext({
  createContextTarStream: () => {
    return createContextTarStreamFromDirectory({
      context: "samples",
      dockerfileContent,
      ignore: undefined
    });
  },
  platform: undefined,
  // how long docker is given to stop politely before it is killed outright
  killGracePeriodMs: 5000,
  spawn
});

const container = context.runImageRaw({ environment: undefined, buildArgs: {} });

const decoder = new TextDecoder();

let ticksSeen = 0;
let givenUp = false;

container.on("data", (event: TRawRunOutputEvent) => {
  if (event.type !== "stdout") {
    // the build log and the container's own stderr both belong on stderr
    process.stderr.write(event.data);
    return;
  }

  process.stdout.write(event.data);

  ticksSeen = ticksSeen + decoder.decode(event.data).split("tick").length - 1;

  // the container would happily tick forever; three is enough to have seen it running
  if (ticksSeen >= 3 && !givenUp) {
    givenUp = true;
    process.stderr.write(`\n--- ${ticksSeen} ticks seen, destroying the stream ---\n`);
    container.destroy();
  }
});

// a destroy with no error emits no "error", but a build that fails on the way there does
container.once("error", (err: Error) => {
  process.stderr.write(`the stream failed: ${err.message}\n`);
});

// destroying always completes; if this never resolved, that would be the bug
await new Promise<void>((resolve) => {
  container.once("close", resolve);
});

// signal 0 signals nothing, it only asks whether the process is still there
const isRunning = ({ pid }: { pid: number }) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForAllToStop = async ({ deadline }: { deadline: number }): Promise<number[]> => {
  const leftovers = startedPids.filter((pid) => {
    return isRunning({ pid });
  });

  if (leftovers.length === 0 || Date.now() > deadline) {
    return leftovers;
  }

  // the processes were signalled, not stopped on the spot, so give them a moment
  await setTimeout(100);

  return waitForAllToStop({ deadline });
};

// this also covers the cleanup the library starts, so by the time it returns the
// container removal has finished too
const leftovers = await waitForAllToStop({ deadline: Date.now() + 15000 });

process.stderr.write(`docker processes started: ${startedPids.length}\n`);
process.stderr.write(`still running after the destroy: ${leftovers.length}\n`);

if (leftovers.length > 0) {
  process.stderr.write(`leaked processes: ${leftovers.join(", ")}\n`);
  // eslint-disable-next-line immutable/no-mutation
  process.exitCode = 1;
}

// the client dying is not the whole story: a container outlives the docker run that
// started it, which is why the library removes it by name as well
const containers = child_process.execFileSync("docker", [
  "ps", "--all", "--quiet", "--filter", "name=node-dockerfiler-"
], { encoding: "utf-8" }).trim();

const containerCount = containers === "" ? 0 : containers.split("\n").length;

process.stderr.write(`containers left behind: ${containerCount}\n`);

if (containerCount > 0) {
  // eslint-disable-next-line immutable/no-mutation
  process.exitCode = 1;
}
