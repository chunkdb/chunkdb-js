# Users and permissions

Connect with a user and password using `connectUri` or `connect({ user, password, ... })`.
Login uses SCRAM-SHA-256 and verifies the server's signature.
A login whose server asks for fewer than 4096 or more than 1000000 PBKDF2 iterations fails with `ChunkProtocolError`; a chunkdb server issues counts in that range.
Use TLS when you need encryption.
Without a user, the client sends an anonymous login.

Only a server started with `--auth none` accepts it.
Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, with an administrator login.

```ts docs-check
await client.createUser("bot", "hunter2");
await client.grant("READ", "world_js", "bot");
console.log((await client.listUsers()).find(({ name }) => name === "bot")?.grants);
await client.revoke("READ", "world_js", "bot");
await client.setPassword("bot", "new-password");
await client.setManagesUsers("bot", false);
await client.dropUser("bot");
```

```output
{ world_js: 'READ' }
```

## Rights

`createUser(name, password, { managesUsers: true })` allows that user to administer users and permissions.
`createUser(name, password, { requiresChannelBinding: true })` lets that user log in only with a login bound to its TLS connection; `setRequiresChannelBinding(name, value)` changes it.
An unbound login of such a user fails with `AUTH_FAILED`, like a wrong password; see [channel binding](CONNECTIONS.md#channel-binding).
`listUsers()` reports `managesUsers`, `requiresChannelBinding` and `grants` for each user.
`ADMIN` includes `WRITE`, which includes `READ`.
Use `"*"` as the table to grant a right on every table.
Revoking a right also removes the higher rights that imply it.

A table with no right is hidden as `NO_TABLE`.
Insufficient rights on a visible table raise `ChunkPermissionError`, naming the required right and table.
`SHOW MIGRATIONS` requires `MANAGES USERS`.
Migrations require their inner statement's rights, even when an identical step would skip.

`setUserLimits(name, { maxConnections?, statementsPerSec? })` sets connection and statement-rate limits; zero disables a limit.

You can change your own password.
Other user operations require `MANAGES USERS`.
The client sends only a computed verifier for password changes, using `verifierIterations` (at least 4096, the default).
`scramVerifier(password, { iterations?, salt? })` is also exported for raw CQL operations.

An existing client keeps its original login password.
Create a new connection with the changed password.
See the [server users guide](https://github.com/chunkdb/chunkdb/blob/main/docs/USERS.md) for bootstrap and offline recovery.

## Server rights and prefixes

`grant("READ", "tenant1_*", user)` covers every table whose name starts with `tenant1_`, future tables included; prefix and `"*"` grants stay when a table is dropped.
MONITOR, BACKUP and REPLICATION are server rights, granted on `"*"` only: MONITOR reads metrics, status, every connection and every table's stats and slots, BACKUP takes backups, and REPLICATION follows every table's feed.
`listUsers()` reports them in `serverRights`.
`ChunkPermissionError` reports `rights`, the rights of which any one would do, such as `["MONITOR", "ADMIN"]`, and `rightsOn`, the table, prefix or `"*"` they are needed on.

## Rotate a password

A user can hold two verifiers, so clients move to a new password while the old one still logs in.
Compute the new verifier with the salt and iterations of the current one, which a login as the user receives as `s=` and `i=` in the SCRAM server-first message:

```text
await admin.addVerifier("bot", scramVerifier("new-password", { salt, iterations }));
// Move every client to the new password, then:
await admin.dropOldVerifier("bot");
```

`listUsers()` reports `verifiers: 2` between the two calls; `setPassword` picks a new salt, so its verifiers fit VERIFIER but not ADD VERIFIER.
