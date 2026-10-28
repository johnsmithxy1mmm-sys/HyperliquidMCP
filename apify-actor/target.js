// Where the Actor sends its request and with which key. Kept apart from
// main.js so it can be tested without the Apify runtime.
const DEFAULT_SERVER_URL = "https://hypersmash.fly.dev/mcp";

/**
 * @param {{ mcpServerUrl?: string, mcpApiKey?: string }} input
 * @param {Record<string, string | undefined>} env
 * @returns {{ url: string, apiKey: string | undefined }}
 */
export function resolveTarget(input, env) {
  const operatorUrl = env.MCP_SERVER_URL || DEFAULT_SERVER_URL;
  // The operator's key may only reach the operator's server: a caller who
  // brings no key of their own cannot redirect the request elsewhere.
  if (!input.mcpApiKey) return { url: operatorUrl, apiKey: env.MCP_API_KEY };
  return { url: input.mcpServerUrl || operatorUrl, apiKey: input.mcpApiKey };
}
