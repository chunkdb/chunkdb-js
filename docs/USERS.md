# Users and permissions

Connect with a user and password using `connectUri` or `connect({ user, password, ... })`.
Login uses SCRAM-SHA-256 and verifies the server's signature; use TLS when the connection must be encrypted.
Without a user, the client sends an anonymous login, accepted only by a server started with `--auth none`.
Examples use an administrator with `MANAGES USERS` and the `world` table from the [README](../README.md).

```ts
await client.createUser("bot", "hunter2");
await client.grant("READ", "world", "bot");
console.log((await client.listUsers()).find(({ name }) => name === "bot")?.grants); // { world: 'READ' }
await client.revoke("READ", "world", "bot");
await client.setPassword("bot", "new-password");
await client.setManagesUsers("bot", false);
await client.dropUser("bot");
```

`createUser(name, password, { managesUsers: true })` allows that user to administer users and permissions.
`ADMIN` includes `WRITE`, which includes `READ`; `"*"` as a table grants a right on every table.
Revoking a right also removes the higher rights that imply it.
A table with no right is hidden as `NO_TABLE`; visible but insufficient rights raise `ChunkPermissionError` naming the required right and table.
A per-table administrator cannot run `SHOW MIGRATIONS` without `MANAGES USERS`; migrations still require their inner statement's rights even when an identical step would skip.

Users can change their own password; other user operations require `MANAGES USERS`.
The client sends only a computed verifier for password changes, using `verifierIterations` (at least 4096, the default).
`scramVerifier(password, { iterations?, salt? })` is also exported for raw CQL operations.
An existing client keeps its original login password; create a new connection with the changed password.
See the [server users guide](https://github.com/chunkdb/chunkdb/blob/main/docs/USERS.md) for bootstrap and offline recovery.
