# Decode extensible replies

Use typed client methods for ordinary application reads and writes.
The low-level `execute` method returns a complete `ChunkReply` when you need a command without a typed helper.
See [API methods](API.md) and [error handling](CONNECTIONS.md#errors) first.

Known array prefixes accept trailing fields, including nested entries and rows.
Known map fields decode independently of unknown keys.
Unknown push kinds are fully consumed and ignored; they cannot take an ordinary request's reply or change ACK eligibility.

An unknown column type returns raw bytes for that row column while known neighbors stay typed.
Unknown-width packed forms require raw form methods, because their neighboring columns cannot be located safely.

Both RESP3 signed integers and big numbers decode as exact bigint values.
Typed narrow integer columns remain numbers; wide integer columns remain bigint.
Schema versions use number within JavaScript's safe range and bigint above it.
Chunk versions, revisions, connection IDs, commit timestamps and transaction IDs remain bigint.

Compare chunk versions only within the same table epoch; revisions can have gaps.

## Parameters

Parameter frames follow numeric index order, independent of where their references occur in the statement.
The client counts `$digits` occurrences outside single-quoted literals and double-quoted identifiers before sending frames.
Doubled quotes escape a quote; an unterminated quote consumes the rest of the line for this count.
The occurrence count must match the number of supplied frames.

The server still validates repeated, zero, gapped and oversized indices semantically after draining their frames.
A successfully drained semantic error leaves the connection available for subsequent requests.
Framing errors close it.

## Explicit features

`showStatus()` returns protected directory and table feature snapshots and `activationPending`.
Each snapshot includes `enabled` feature names and exact bigint `compat`, `roCompat` and `incompat` masks.
Unknown feature names and mask bits remain visible.
`enableFeature(name)` explicitly activates a feature and requires ADMIN on `*`.

Features are monotonic; dropping the last slot or migration does not disable them.
Existing directories can require `feature_activation` before another activation.
Inspect structured `reason` and `feature` diagnostics if an operation needs a disabled feature.
Feature activation can fail with OUTCOME_UNKNOWN; reconcile status after recovery instead of automatically replaying dependent writes.
