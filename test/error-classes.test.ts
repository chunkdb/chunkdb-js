import test from "node:test";
import assert from "node:assert/strict";
import * as chunk from "../src/index";
import { ChunkServerError, connectUri } from "../src/index";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

// Every server error code, its class and its retry class.
const CLASSES: Array<[string, new (...args: never[]) => ChunkServerError, string]> = [
  ["PROTOCOL", chunk.ChunkServerProtocolError, "fatal"],
  ["BAD_REQUEST", chunk.ChunkBadRequestError, "fatal"],
  ["AUTH_REQUIRED", chunk.ChunkAuthError, "fatal"],
  ["AUTH_FAILED", chunk.ChunkAuthError, "fatal"],
  ["PERMISSION_DENIED", chunk.ChunkPermissionError, "fatal"],
  ["SYNTAX", chunk.ChunkSyntaxError, "fatal"],
  ["INVALID_ARGUMENT", chunk.ChunkInvalidArgumentError, "fatal"],
  ["OUT_OF_RANGE", chunk.ChunkOutOfRangeError, "fatal"],
  ["NO_TABLE", chunk.ChunkNoTableError, "fatal"],
  ["TABLE_EXISTS", chunk.ChunkTableExistsError, "fatal"],
  ["UNKNOWN_COMMAND", chunk.ChunkUnknownCommandError, "fatal"],
  ["CHECK_FAILED", chunk.ChunkCheckFailedError, "fatal"],
  ["MIGRATION_MISMATCH", chunk.ChunkMigrationMismatchError, "fatal"],
  ["SLOT_BUSY", chunk.ChunkSlotBusyError, "fatal"],
  ["SLOT_LOST", chunk.ChunkSlotLostError, "fatal"],
  ["RESYNC_REQUIRED", chunk.ChunkResyncRequiredError, "fatal"],
  ["CANCELLED", chunk.ChunkCancelledError, "fatal"],
  ["TIMEOUT", chunk.ChunkStatementTimeoutError, "fatal"],
  ["KILLED", chunk.ChunkKilledError, "fatal"],
  ["INTERNAL", chunk.ChunkInternalError, "fatal"],
  ["VERSION_MISMATCH", chunk.ChunkVersionMismatchError, "reread"],
  ["CONDITION_FAILED", chunk.ChunkConditionFailedError, "reread"],
  ["SCHEMA_MISMATCH", chunk.ChunkSchemaMismatchError, "reread"],
  ["CONFLICT", chunk.ChunkConflictError, "rerun"],
  ["BUSY", chunk.ChunkBusyError, "backoff"],
  ["DISK_FULL", chunk.ChunkDiskFullError, "backoff"],
  ["RATE_LIMITED", chunk.ChunkRateLimitedError, "backoff"],
  ["OUTCOME_UNKNOWN", chunk.ChunkOutcomeUnknownError, "unknown_outcome"],
];

test("every server error code decodes to its own class", async () => {
  const server = await startFakeServer((request) => {
    if (request.line.startsWith("HELLO 3")) return FAKE_HELLO;
    const code = request.line.replace(/^ERR /, "");
    return `-ERR ${code} reason=why current=3 detail\r\n`;
  });
  try {
    const client = await connectUri(`chunk://127.0.0.1:${server.port}/`);
    for (const [code, ErrorClass, retryClass] of CLASSES) {
      await assert.rejects(client.execute(`ERR ${code}`), (error: unknown) => {
        assert.ok(error instanceof ErrorClass, code);
        assert.ok(error instanceof ChunkServerError, code);
        assert.equal(error.constructor, ErrorClass, code);
        assert.equal(error.serverCode, code);
        assert.equal(error.retryClass, retryClass);
        assert.equal(error.reason, "why");
        return true;
      });
    }
    await assert.rejects(client.execute("ERR FUTURE_CODE"), (error: unknown) =>
      error instanceof ChunkServerError && error.constructor === ChunkServerError && error.retryClass === "fatal");
    await client.close();
  } finally { await server.close(); }
});
