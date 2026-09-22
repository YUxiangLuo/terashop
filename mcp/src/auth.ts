import { startOidcService } from './oidc-service';

// Build with Bun for Node; never deploy oidc-provider under Bun's runtime.
try {
  if (
    process.versions.bun ||
    Number(process.versions.node.split('.')[0]) !== 22 ||
    !process.release.lts ||
    process.argv.length !== 3
  )
    throw new Error('Unsupported startup');
  const service = await startOidcService(process.argv[2]);
  const stop = () => {
    void service.close().catch(() => {
      process.stderr.write('OIDC_SERVICE_STOP_FAILED\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write('OIDC_SERVICE_READY\n');
} catch {
  process.stderr.write('OIDC_SERVICE_START_FAILED\n');
  process.exitCode = 1;
}
