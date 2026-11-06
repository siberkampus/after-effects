import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["C:/Users/ACER/Documents/mcp/after-effects-mcp/packages/mcp-server/dist/index.js"],
  cwd: "C:/Users/ACER/Documents/mcp/after-effects-mcp"
});

const client = new Client({ name: "ae-create-comp", version: "1.0.0" });

try {
  await client.connect(transport);

  const result = await client.callTool({
    name: "create_comp",
    arguments: {
      name: "HUD_DEMO",
      width: 1920,
      height: 1080,
      frameRate: 30,
      duration: 15,
      bgColor: "#080D18"
    }
  });

  console.log("\nKOMPOZSYON OLUŞTURMA SONUCU:");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close().catch(() => {});
}
