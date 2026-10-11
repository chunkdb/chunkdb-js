# Users and permissions

Connect with a user and password using `connectUri` or `connect({ user, password, ... })`.
Login uses SCRAM-SHA-256 and verifies the server's signature.
Use TLS when you need encryption.
Without a user, the client sends an anonymous login.

Only a server started with `--auth none` accepts it.
Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, with an administrator login.

```ts docs-check
await client.createUser("bot", "hunter2");
await client.grant("READ", "world", "bot");
console.log((await client.listUsers()).find(({ name }) => name === "bot")?.grants);
await client.revoke("READ", "world", "bot");
await client.setPassword("bot", "new-password");
await client.setManagesUsers("bot", false);
await client.dropUser("bot");
```

```output
{ world: 'READ' }
```

## Rights

`createUser(name, password, { managesUsers: true })` allows that user to administer users and permissions.
`ADMIN` includes `WRITE`, which includes `READ`.
Use `"*"` as the table to grant a right on every table.
Revoking a right also removes the higher rights that imply it.

A table with no right is hidden as `NO_TABLE`.
Insufficient rights on a visible table raise `ChunkPermissionError`, naming the required right and table.
`SHOW MIGRATIONS` requires `MANAGES USERS`.
Migrations require their inner statement's rights, even when an identical step would skip.

You can change your own password.
Other user operations require `MANAGES USERS`.
The client sends only a computed verifier for password changes, using `verifierIterations` (at least 4096, the default).
`scramVerifier(password, { iterations?, salt? })` is also exported for raw CQL operations.

An existing client keeps its original login password.
Create a new connection with the changed password.
See the [server users guide](https://github.com/chunkdb/chunkdb/blob/main/docs/USERS.md) for bootstrap and offline recovery.
