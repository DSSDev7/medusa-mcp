import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import MedusaStoreService from "./services/medusa-store";
import MedusaAdminService from "./services/medusa-admin";
import * as allowedToolsJson from "./allowed-tools.json";

const allowedToolsConfig = allowedToolsJson as {
    allowedTools: string[];
    allowAllTools: boolean;
};

async function main(): Promise<void> {
    console.error("Starting Medusa Store MCP Server...");
    const medusaStoreService = new MedusaStoreService();
    const medusaAdminService = new MedusaAdminService();
    let tools = [];
    try {
        await medusaAdminService.init();

        tools = [
            ...medusaStoreService.defineTools(),
            ...medusaAdminService.defineTools()
        ];
    } catch (error) {
        console.error("Error initializing Medusa Admin Services:", error);
        tools = [...medusaStoreService.defineTools()];
    }

    // Filter tools based on allowed-tools.json configuration
    const totalToolsCount = tools.length;
    if (!allowedToolsConfig.allowAllTools && allowedToolsConfig.allowedTools && allowedToolsConfig.allowedTools.length > 0) {
        const allowedToolNames = new Set(allowedToolsConfig.allowedTools);
        const originalTools = tools;
        tools = tools.filter((tool) => allowedToolNames.has(tool.name));

        const filteredCount = totalToolsCount - tools.length;
        console.error(`Tool filtering enabled: ${tools.length}/${totalToolsCount} tools allowed`);

        if (filteredCount > 0) {
            const disabledTools = originalTools
                .filter((tool) => !allowedToolNames.has(tool.name))
                .map((tool) => tool.name);
            console.error(`Disabled tools (${filteredCount}):`, disabledTools.slice(0, 5).join(", "),
                filteredCount > 5 ? `... and ${filteredCount - 5} more` : "");
        }
        console.log(JSON.stringify(tools))
    } else {
        console.error(`All tools enabled: ${totalToolsCount} tools available`);
    }

    const server = new McpServer(
        {
            name: "Medusa Store MCP Server",
            version: "1.0.0"
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    tools.forEach((tool) => {
        server.tool(
            tool.name,
            tool.description,
            tool.inputSchema,
            tool.handler
        );
    });

    const app = express();
    const PORT = process.env.PORT || 3000;

    // Parse JSON bodies for POST requests
    app.use(express.json());

    // Streamable HTTP transport endpoint
    app.post("/mcp", async (req, res) => {
        console.error("MCP request received");

        // Create a new transport for each request to prevent request ID collisions
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });

        // Clean up on connection close
        res.on("close", () => {
            transport.close();
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    app.listen(PORT, () => {
        console.error(`Medusajs MCP Server running on http://localhost:${PORT}/mcp`);
    }).on('error', (error) => {
        console.error('Server error:', error);
        process.exit(1);
    });
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
