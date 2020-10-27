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
