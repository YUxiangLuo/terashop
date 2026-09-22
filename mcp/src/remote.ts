import { startAdminHttpService } from './http-service';

try {
  if (!process.versions.bun || process.argv.length !== 3) throw new Error('Invalid startup');
  const service = await startAdminHttpService(process.argv[2]);
  const stop = () => {
    void service.close().catch(() => {
      process.stderr.write('MCP_HTTP_STOP_FAILED\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write('MCP_HTTP_READY\n');
} catch {
  process.stderr.write('MCP_HTTP_START_FAILED\n');
  process.exitCode = 1;
}
