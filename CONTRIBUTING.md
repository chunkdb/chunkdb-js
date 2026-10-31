# Contributing

Use the [organization contribution guide](https://github.com/chunkdb/.github/blob/main/CONTRIBUTING.md) for reporting issues and proposing changes.

## Local checks

Use the Node.js requirement and package manager declared in `package.json`.
Run these checks from the repository root:

```bash
npm ci
npm run build
npm run test:unit
```

For the full suite, including integration tests, keep a chunkdb checkout beside this repository or set `CHUNKDB_REPO_ROOT` to its absolute path:

```bash
CHUNKDB_REPO_ROOT=/path/to/chunkdb npm test
```

The test script builds a server with TLS support using CMake and OpenSSL.
To use an existing server build instead, set both `CHUNKDB_SERVER_BIN` and `CHUNKDB_SERVER_BIN_TLS` to the corresponding absolute executable paths.
Both may point to one TLS-enabled executable.
Keep `CHUNKDB_REPO_ROOT` set to the source checkout when supplying binaries from another directory.
Keep `README.md` focused on package users; put contributor and release instructions in their dedicated documents.
## Check documentation examples

Run `npm run build` and `npm run test:integration` to check the examples alongside the existing integration tests.
The runner needs the current server, as resolved by `test/helpers.ts`.
You can supply `CHUNKDB_REPO_ROOT`, `CHUNKDB_SERVER_BIN` and `CHUNKDB_SERVER_BIN_TLS` explicitly.

Mark executable TypeScript blocks in `README.md` and `docs/*.md` with `ts docs-check`.
Follow each block with an `output` fence containing its exact standard output.
Every TypeScript block in these pages must be marked, and every marked block must have output.

README and connections blocks run as complete programs against fresh servers.
Guide blocks run in page order inside a connected client's `try` block.
The runner creates the README's `world` table and imports the helpers named by the guides.
It supplies an authenticated URI with `/world` as its path.
Backup examples get an empty server backup directory.

The runner resolves `@chunkdb/client` to the local built package, so it checks packaged exports.
It compares output exactly, normalizing only line endings.
Keep output stable by printing data rather than generated versions, epochs or timestamps.
A subprocess deadline fails a hung example and names its page.
The existing CI integration command runs this check on Linux and macOS.
