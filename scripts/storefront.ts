import { localSupabase } from "./lib/local-supabase";

const mode = Bun.argv[2];
if (mode !== "dev" && mode !== "build" && mode !== "check")
  throw new Error("Expected dev, build or check");
const env = { ...process.env };
if (mode === "check") {
  env.PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
  env.PUBLIC_SUPABASE_ANON_KEY ||= "typecheck-only";
}
// Supply only public local credentials. Never expose the service key or DB URL.
if (!env.PUBLIC_SUPABASE_URL && !env.PUBLIC_SUPABASE_ANON_KEY) {
  const local = localSupabase();
  env.PUBLIC_SUPABASE_URL = local.API_URL;
  env.PUBLIC_SUPABASE_ANON_KEY = local.ANON_KEY;
}
if (!env.PUBLIC_SUPABASE_URL || !env.PUBLIC_SUPABASE_ANON_KEY) {
  throw new Error(
    "Both PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY are required",
  );
}
const child = Bun.spawn(["bun", "run", "--cwd", "storefront", mode], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
