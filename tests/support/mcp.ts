import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AdminBackend } from '../../mcp/src/backend';
import { createAdminServer } from '../../mcp/src/server';
import type { ToolAuthorization } from '../../mcp/src/permissions';

export async function mcpSession(
  backend: AdminBackend,
  allowWrites = false,
  authorization?: ToolAuthorization,
  adminOrigin?: string,
) {
  const server = createAdminServer(backend, { allowWrites, authorization, adminOrigin });
  const client = new Client({ name: 'tera-tests', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export async function toolData<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  if (
    !result.structuredContent ||
    typeof result.structuredContent !== 'object' ||
    !('data' in result.structuredContent)
  )
    throw new Error('Missing structured result');
  return result.structuredContent.data as T;
}
