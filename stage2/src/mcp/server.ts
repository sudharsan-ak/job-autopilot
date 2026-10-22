import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BatchApplicationInputSchema, TestToolInputSchema, ToolOutputSchema } from "./schema.js";
import { Stage2Runtime } from "./dispatcher.js";

const runtime = new Stage2Runtime();

serveStdio(() => {
  const server = new McpServer(
    { name: "application-automation", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "batch_application_process",
    {
      title: "Batch Application Process",
      description: "Load and prepare selected job applications, upload recognized resume files when needed, resolve uncertain fields, track progress, and report results. Never submits applications.",
      inputSchema: BatchApplicationInputSchema,
      outputSchema: ToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const output = await runtime.dispatch(input);
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        const output = { ok: false, error: error instanceof Error ? error.message : String(error) };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      }
    },
  );

  server.registerTool(
    "batch_application_process_test",
    {
      title: "Batch Application Process Test",
      description: "Run isolated diagnostics and page inspection, or explicitly trigger Simplify autofill in the dedicated CDP Chrome. The Simplify mode never invokes the Stage 2 field filler and never submits applications.",
      inputSchema: TestToolInputSchema,
      outputSchema: ToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const output = await runtime.dispatchTest(input);
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        const output = { ok: false, error: error instanceof Error ? error.message : String(error), production_state_mutated: false };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      }
    },
  );

  return server;
}, {
  onerror: (error) => console.error(error),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    runtime.close();
    process.exit(0);
  });
}

process.stdin.once("end", () => {
  runtime.close();
  process.exit(0);
});
