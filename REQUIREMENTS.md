# Requirements

## Checks

`npm test`, `npm run lint`, and `npm run type-check` finish with no errors. Each commit keeps all three that way.

## Library

- Images are built and run through the Docker CLI (`docker buildx` and `docker run`). The package does not depend on `dockerode`.
- A build context is a tar stream. `createContextTarStreamFromDirectory` and `createContextTarStreamFromFiles` append the Dockerfile to that stream.
- Logs and image bytes are streams of tagged events. Destroying a stream stops the docker process behind it.
- The published package is the `dist` build described by `package.npm.json`.
