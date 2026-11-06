import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: [
    "C:/Users/ACER/Documents/mcp/after-effects-mcp/packages/mcp-server/dist/index.js"
  ],
  cwd: "C:/Users/ACER/Documents/mcp/after-effects-mcp"
});

const client = new Client({
  name: "ae-ai-studio",
  version: "1.0.0"
});

try {
  await client.connect(transport);

  const result = await client.listTools();

  console.log("\nMCP BAĞLANTISI BAŞARILI!");
  console.log("Bulunan araç sayısı:", result.tools.length);

  for (const tool of result.tools) {
    console.log("-", tool.name);
  }
} catch (error) {
  console.error("MCP bağlantı hatası:", error);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
