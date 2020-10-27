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
