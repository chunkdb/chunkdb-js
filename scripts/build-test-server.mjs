// Builds the chunkdb server used by the integration tests into
// <chunkdbRepoRoot>/build-js-tests, resolving the chunkdb repo the same way
// test/helpers.ts does (CHUNKDB_REPO_ROOT, else ../chunkdb relative to this
// package). Using one resolution path keeps `npm run test:server` and the
// test harness pointed at the same tree, on a plain checkout and in the
// release workflow (which checks chunkdb out inside the package as ./chunkdb).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chunkdbRoot =
  process.env.CHUNKDB_REPO_ROOT ?? path.resolve(packageRoot, "../chunkdb");
const buildDir = path.join(chunkdbRoot, "build-js-tests");

function run(args) {
  const result = spawnSync("cmake", args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run([
  "-S", chunkdbRoot,
  "-B", buildDir,
  "-DCMAKE_BUILD_TYPE=Debug",
  "-DCHUNKDB_BUILD_TESTS=OFF",
  "-DCHUNKDB_WITH_TLS=ON",
]);
run(["--build", buildDir, "--target", "chunkdb_server", "--config", "Debug"]);
