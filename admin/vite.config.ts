import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv } from "vite";
import { mcpOnboarding } from "./src/lib/mcp-onboarding.ts";

export default defineConfig(({ mode }) => {
  // Fail the build instead of publishing malformed or credential-bearing config.
  const connection = loadEnv(mode, process.cwd(), "PUBLIC_").PUBLIC_MCP_CONNECTION;
  mcpOnboarding(connection);
  process.env.PUBLIC_MCP_CONNECTION ??= connection ?? "";
  return { plugins: [sveltekit()] };
});
