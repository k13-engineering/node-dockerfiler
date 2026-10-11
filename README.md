# node-dockerfiler

Builds and runs a Dockerfile through the Docker CLI. The build context is streamed in, and the logs and image bytes are streamed out. Nothing is written to the filesystem except the image id file docker itself creates.

This is the equivalent of `docker buildx build` followed by `docker run` or `docker buildx build --output type=tar`, without leaving a Dockerfile on disk.

## Requirements

- Node.js 24
- The Docker CLI, including `docker buildx`

## Usage

A context factory returns a fresh tar stream that already contains the Dockerfile. `createContextTarStreamFromDirectory` packs a directory. `createContextTarStreamFromFiles` packs buffers the caller already holds. `createDefaultDockerBuildContext` turns that factory into a context.

Destroying a stream stops the build or the container it started.

### Run an image

`runImage` emits object events tagged `build-log`, `stdout`, or `stderr`. `runImageRaw` leaves the build log as the bytes docker printed. `samples/hello.ts` is the small case, and `samples/advanced.ts` passes build arguments, environment, stdin, and an ignore filter.

### Export an image

`exportImageAsTarStreamRaw` emits the image tar and the plain build log on one stream. Pipe it through `buildStreamToTar` to keep the tar and send the log to a sink, as `samples/export-tar.ts` does. `buildStreamToFileInTar` extracts one file from that tar, as `samples/export-file.ts` does.

## Checks

`npm test`, `npm run lint`, and `npm run type-check` finish with no errors.
