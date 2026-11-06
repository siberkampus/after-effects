import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["C:/Users/ACER/Documents/mcp/after-effects-mcp/packages/mcp-server/dist/index.js"],
  cwd: "C:/Users/ACER/Documents/mcp/after-effects-mcp"
});

const client = new Client({ name: "ae-tool-inspector", version: "1.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();

  for (const name of ["init_project", "create_comp"]) {
    const tool = tools.find(t => t.name === name);
    console.log("\n--- " + name + " ---");
    console.log(JSON.stringify(tool, null, 2));
  }
} finally {
  await client.close().catch(() => {});
}
