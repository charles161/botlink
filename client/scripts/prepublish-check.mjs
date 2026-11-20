#!/usr/bin/env node
// npm publish guard (prepublishOnly; NPM-PUBLISH.md). The repo's package is "botlink", the name of the tarball the
// server hands out at /dl. On npm the client is "@botlink/cli" (npm refused the bare name), made by `npm run pack:npm`
// and published as a file: `npm publish <botlink-cli-x.y.z.tgz> --access public`. A plain `npm publish` from here
// would try the refused name, so it stops.
console.error("Refusing to publish from client/: run `npm run pack:npm`, then `npm publish <the botlink-cli-x.y.z.tgz it prints> --access public` (see NPM-PUBLISH.md).");
process.exit(1);
