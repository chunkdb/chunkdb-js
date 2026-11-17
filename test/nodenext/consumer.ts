// Compiled with NodeNext resolution against the built package declarations.
// Run npm run build before npm run test:types; the package exports point at dist/.
import { ChunkError, connectUri, type ChunkClient, type ChunkReply } from "@chunkdb/client";

export async function ping(uri: string): Promise<ChunkReply> {
  const client: ChunkClient = await connectUri(uri);
  try {
    return await client.execute("PING");
  } catch (error) {
    if (error instanceof ChunkError) {
      throw new Error(error.message);
    }
    throw error;
  } finally {
    await client.close();
  }
}
