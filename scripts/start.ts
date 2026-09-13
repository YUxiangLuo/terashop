// Project-scoped Docker binding; never change the daemon or global firewall.
export {};
const network = 'tera-headless-loopback';
function run(args: string[]): string {
  const result = Bun.spawnSync(args, { stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args[0]} ${args[1]}`);
  return result.stdout.toString().trim();
}
const networks = run(['docker', 'network', 'ls', '--format', '{{.Name}}']).split('\n');
if (!networks.includes(network)) {
  run(['docker', 'network', 'create', '--driver', 'bridge', '--opt',
    'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', network]);
}
const [config] = JSON.parse(run(['docker', 'network', 'inspect', network]));
if (config.Driver !== 'bridge' || config.Options?.['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1') {
  throw new Error('Existing project network is not loopback-only; refusing to start');
}
const { project_id: project } = Bun.TOML.parse(await Bun.file('supabase/config.toml').text()) as { project_id: string };
function checkBindings() {
  const ids = run(['docker', 'ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]).split('\n').filter(Boolean);
  if (!ids.length) return;
  for (const container of JSON.parse(run(['docker', 'inspect', ...ids]))) {
    for (const bindings of Object.values(container.NetworkSettings.Ports ?? {}) as Array<Array<{ HostIp: string }> | null>) {
      if (bindings?.some(binding => !['127.0.0.1', '::1'].includes(binding.HostIp))) {
        throw new Error('Existing Supabase ports are not loopback-only; run bun run stop, then bun run start');
      }
    }
  }
}
checkBindings();
const child = Bun.spawn(['bunx', '--no-install', 'supabase', 'start', '--network-id', network], {
  stdout: 'inherit', stderr: 'inherit',
});
if (await child.exited !== 0) process.exit(child.exitCode ?? 1);
checkBindings();
