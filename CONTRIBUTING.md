# Contributing

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
