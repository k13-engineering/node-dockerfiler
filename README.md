# node-dockerfiler
Node.js library to run Dockerfiles easily

## About

This library supports the use-case, that you have to create a docker container from a Dockerfile and run it one-shot.

Essentially what this library does is the equivalent of:

```bash
$ docker build -t mytag . -f /path/to/Dockerfile
$ docker run --rm mytag
```

but without the need to have the Docker CLI installed or to create an intermediate Dockerfile in the filesystem.

## Requirements

- `Node.js >= 10` as ES6 modules are used. Transpiling for backward compatibility is not yet setup but may be added in the future.
- `Docker` - should actually work with most if not all versions

## Usage

### Minimal example

```javascript
import dockerfiler from "../lib/index.js";

const dockerfileContent = `
  FROM debian:buster
  CMD echo Hello, World!
`;

await dockerfiler.run({
  dockerfileContent,
  // build context directory
  "context": "."
});
```

### Advanced example

```javascript
import dockerfiler from "../lib/index.js";

const dockerfileContent = `
  FROM debian:buster
`;

await dockerfiler.run({
  dockerfileContent,
  // build context directory
  "context": ".",
  // options passed to docker (see https://docs.docker.com/engine/api/v1.37/#operation/ContainerCreate)
  "options": {
    "Env": [
      "MYENV=World"
    ]
  },
  // callback to allow ignoring files sent to build context
  "ignore": () => {
    return false;
  },
  // command to execute when running the container
  "command": [ "/bin/bash", "-c", "echo Hello, ${MYENV}!" ],
  // where to write the logs
  "logSink": process.stderr
});
```

## Roadmap

- Add support for providing docker connection details, currently only dockerode default behaviour is supported
- Improve log API
  - Split build and run logs
