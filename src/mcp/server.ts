import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { SourceError } from "../project.js";
import {
  diffDocument,
  getDocument,
  getItem,
  listDocuments,
  listItems,
  QueryError,
  resolveItems,
  type McpContext,
} from "./query.js";

const SERVER_INFO = {
  name: "spec-clarify",
  version: "0.1.8",
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof QueryError || error instanceof SourceError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function runTool(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

export interface CreateMcpServerOptions {
  allowWrite?: boolean;
}

export function createMcpServer(ctx: McpContext, options: CreateMcpServerOptions = {}): McpServer {
  const allowWrite = Boolean(options.allowWrite);
  const server = new McpServer(SERVER_INFO, {
    instructions: allowWrite
      ? '查询 spec-clarify 项目的审核条目澄清结论、讨论记录、源文档原文与修订版变更对比，并支持将已处理的澄清标记为已落地（resolve_items）。读取待落地澄清建议调用 list_items(status="clarified", applied=false)。'
      : '只读查询 spec-clarify 项目的审核条目澄清结论、讨论记录、源文档原文与修订版变更对比。读取未落地澄清可传入 status="clarified", applied=false。',
  });
  server.registerTool(
    "list_items",
    {
      title: "查询审核条目与澄清状态",
      description:
        "按状态、分组、严重度或关键词筛选审核条目，返回项目统计、分组进度与每条目的最新澄清结论摘要。",
      inputSchema: {
        status: z
          .enum(["all", "pending", "open", "clarified", "stale", "awaiting"])
          .optional()
          .describe(
            "状态筛选：all（全部）、pending（未澄清/需复核/待回复）、open（未澄清）、clarified（已澄清）、stale（需复核）、awaiting（待回复）",
          ),
        applied: z
          .boolean()
          .optional()
          .describe(
            "可选：按是否已落地筛选（false 仅返回当前澄清尚未标记已落地的条目；配合 status=clarified 可精确获取待处理批次）",
          ),
        afterClarificationId: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("可选：只返回最新澄清 ID 大于该游标的条目，用于按批次增量拉取"),
        group: z.string().optional().describe("按分组 key 或分组标题筛选"),
        severity: z
          .string()
          .optional()
          .describe("按严重度筛选；传入 none 表示筛选未设置严重度的条目"),
        q: z.string().optional().describe("按编号、标题、正文、字段或最新澄清内容关键词筛选"),
        includeBody: z
          .boolean()
          .optional()
          .describe("是否一并返回每条目的 fields 与 body（默认 false 以精简输出）"),
        limit: z.number().int().min(1).max(500).optional().describe("返回条数上限（默认 100）"),
        offset: z.number().int().min(0).optional().describe("分页偏移量（默认 0）"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => runTool(() => listItems(ctx, args)),
  );

  server.registerTool(
    "get_item",
    {
      title: "获取单个审核条目详情",
      description:
        "获取指定编号条目的完整审核意见、澄清与评论历史、关联条目、反向引用，以及按引用自动截取的源文档原文对照片段。",
      inputSchema: {
        id: z.string().min(1).describe("条目编号，例如 L1、T2"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ id }) => runTool(() => getItem(ctx, id)),
  );

  server.registerTool(
    "list_documents",
    {
      title: "列出项目文档与修订版变更摘要",
      description:
        "列出全部源文档与审核文档，以及各修订版（revisions）的新增与增删行数统计，无需手动翻目录核对版本差异。",
      inputSchema: {
        rev: z.string().optional().describe("可选：查看文档在指定修订版中的状态"),
        changedOnly: z
          .boolean()
          .optional()
          .describe("仅返回有变更（或指定修订版中新增/修改）的文档"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => runTool(() => listDocuments(ctx, args)),
  );

  server.registerTool(
    "get_document",
    {
      title: "读取源文档或修订版原文",
      description:
        "读取指定源文档或审核文档的 Markdown 内容（带物理行号）；指定 rev 时若该文件未在该版本修改，会自动返回其继承的上一修订版或基线版本内容。",
      inputSchema: {
        path: z.string().min(1).describe("文档路径、修订路径或唯一短文件名（如 specs/login.md）"),
        rev: z.string().optional().describe("修订版 ID，或传入 baseline 查看基线原文"),
        startLine: z.number().int().min(1).optional().describe("起始行号（1-based，默认 1）"),
        endLine: z.number().int().min(1).optional().describe("结束行号（1-based，默认末尾）"),
        withLineNumbers: z.boolean().optional().describe("是否在每行前附带行号（默认 true）"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => runTool(() => getDocument(ctx, args)),
  );

  server.registerTool(
    "diff_document",
    {
      title: "对比源文档修订版本差异",
      description:
        "输出指定文档在修订版中的纯文本 Unified Diff；默认对比上一修订版（或基线），也可传入 baseRev 指定任意两个版本对比。",
      inputSchema: {
        path: z.string().min(1).describe("文档路径或唯一短文件名"),
        rev: z.string().min(1).describe("目标修订版 ID"),
        baseRev: z
          .string()
          .optional()
          .describe(
            "可选：基准版本 ID（传入 baseline 表示基线；省略则按站点默认规则对比上一版本）",
          ),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("每个变更块保留的上下文行数（默认 3）"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => runTool(() => diffDocument(ctx, args)),
  );

  if (allowWrite) {
    server.registerTool(
      "resolve_items",
      {
        title: "标记审核条目澄清已落地或重新打开",
        description:
          "记录某条目最新澄清结论已被处理落地（applied）或重新打开（reopened）。建议传入读取到的 latestClarification.id 作为 clarificationId，防止覆盖期间新增的澄清结论。",
        inputSchema: {
          items: z
            .array(
              z.object({
                id: z.string().min(1).describe("条目编号，例如 L1"),
                clarificationId: z
                  .number()
                  .int()
                  .min(1)
                  .optional()
                  .describe(
                    "预期处理的澄清 ID（latestClarification.id），不一致时拒绝写入并报告冲突",
                  ),
                note: z.string().max(1000).optional().describe("本条目的落地说明（可选）"),
              }),
            )
            .min(1)
            .max(100)
            .describe("待标记的条目列表"),
          action: z
            .enum(["applied", "reopened"])
            .optional()
            .describe("操作类型：applied（已落地，默认）或 reopened（重新打开为待落地）"),
          actor: z.string().max(100).optional().describe("处理方标识，默认 ai"),
          note: z.string().max(1000).optional().describe("统一落地说明（条目未单独指定时使用）"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      (args) => runTool(() => resolveItems(ctx, args)),
    );
  }

  return server;
}

export async function runStdioMcpServer(
  ctx: McpContext,
  streams?: { stdin?: Readable; stdout?: Writable },
  options?: CreateMcpServerOptions,
): Promise<void> {
  const stdin = streams?.stdin ?? process.stdin;
  const stdout = streams?.stdout ?? process.stdout;
  const server = createMcpServer(ctx, options);
  const transport = new StdioServerTransport(stdin, stdout);
  await server.connect(transport);
  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  const finish = (closeServer: boolean) => {
    if (settled) return;
    settled = true;
    stdin.off("end", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (closeServer) void server.close().finally(resolve);
    else resolve();
  };
  const onSignal = () => finish(true);
  transport.onclose = () => finish(false);
  stdin.once("end", onSignal);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await promise;
}

export async function handleMcpHttpRequest(
  ctx: McpContext,
  req: Request,
  options?: CreateMcpServerOptions,
): Promise<Response> {
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method Not Allowed: use POST /mcp" },
        id: null,
      }),
      {
        status: 405,
        headers: {
          Allow: "POST, DELETE",
          "Content-Type": "application/json",
        },
      },
    );
  }

  const server = createMcpServer(ctx, options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
