#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { generatePassword, hashPassword } from "./auth.js";
import { renderExport } from "./export.js";
import {
  DEFAULT_CONFIG_FILE,
  loadProjectConfig,
  loadWorkspace,
  type ProjectConfig,
} from "./project.js";
import { openDatabase } from "./store/database.js";
import { EntryStore } from "./store/entries.js";
import { isRole, ROLES, ROLE_LABELS, UserStore } from "./store/users.js";
import { createApp } from "./web/app.js";

const USAGE = `用法：spec-clarify <命令> [选项]

命令：
  serve                                  启动站点
  check                                  校验配置、源文档与审核文档
  export [-o <文件>]                     导出澄清记录（默认输出到标准输出）
  user add <用户名> --name <姓名> --role <${ROLES.join("|")}>
                                         创建账号并打印初始密码
  user reset-password <用户名>           重置密码并打印新密码，结束该账号所有登录
  user role <用户名> <${ROLES.join("|")}>      修改角色
  user disable <用户名>                  停用账号并结束其所有登录
  user enable <用户名>                   启用账号
  user list                              列出账号

通用选项：
  -c, --config <文件>   项目配置文件，默认 ./${DEFAULT_CONFIG_FILE}

serve 选项（也可用环境变量）：
  --host <地址>         监听地址，默认 127.0.0.1（SPEC_CLARIFY_HOST）
  --port <端口>         端口，默认 3100（SPEC_CLARIFY_PORT）
  --secure-cookies      会话 Cookie 只经 HTTPS 发送（SPEC_CLARIFY_SECURE_COOKIES=1）
`;

class UsageError extends Error {}

async function withStores<T>(
  config: ProjectConfig,
  run: (stores: { entries: EntryStore; users: UserStore }) => Promise<T>,
): Promise<T> {
  const client = await openDatabase(config.databasePath);
  try {
    return await run({ entries: new EntryStore(client), users: new UserStore(client) });
  } finally {
    client.close();
  }
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new UsageError("端口必须是 1–65535 之间的整数");
  }
  return Number(raw);
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: DEFAULT_CONFIG_FILE },
      output: { type: "string", short: "o" },
      host: { type: "string" },
      port: { type: "string" },
      "secure-cookies": { type: "boolean" },
      name: { type: "string" },
      role: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const config = await loadProjectConfig(values.config);

  switch (command) {
    case "check": {
      const { review, reviews, documents } = await loadWorkspace(config);
      for (const group of review.groups) {
        const count = review.items.filter((item) => item.group === group).length;
        console.log(`${String(count).padStart(5)}  ${group.title}`);
      }
      console.log(
        `共 ${review.items.length} 个条目、${review.groups.length} 个分组；${reviews.length} 份审核文档、${documents.length - reviews.length} 份源文档`,
      );
      return;
    }

    case "export": {
      const { review, reviews } = await loadWorkspace(config);
      const markdown = await withStores(config, async ({ entries }) =>
        renderExport({
          title: config.title,
          sources: reviews.map((doc) => doc.path),
          review,
          entries: await entries.all(),
          activity: await entries.activity(),
          generatedAt: new Date(),
        }),
      );
      if (values.output) {
        await writeFile(values.output, markdown);
        console.error(`已写入 ${values.output}`);
      } else process.stdout.write(markdown);
      return;
    }

    case "serve": {
      const host = values.host ?? process.env.SPEC_CLARIFY_HOST ?? "127.0.0.1";
      const port = parsePort(values.port ?? process.env.SPEC_CLARIFY_PORT ?? "3100");
      const secureCookies =
        values["secure-cookies"] ?? process.env.SPEC_CLARIFY_SECURE_COOKIES === "1";
      // Fail at startup, not on the first request, when the sources cannot be read.
      const { review } = await loadWorkspace(config);
      const client = await openDatabase(config.databasePath);
      const users = new UserStore(client);
      const app = createApp({ config, entries: new EntryStore(client), users, secureCookies });
      if ((await users.count()) === 0) {
        console.warn("尚无账号：先运行 spec-clarify user add <用户名> --name <姓名> --role admin");
      }
      const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
        console.log(
          `${config.title}: http://${info.address}:${info.port}（${review.items.length} 个条目，数据库 ${config.databasePath}）`,
        );
      });
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          server.close(() => {
            client.close();
            process.exit(0);
          });
        });
      }
      return;
    }

    case "user": {
      const [action, username, extra] = args;
      await withStores(config, async ({ users }) => {
        if (action === "list") {
          for (const user of await users.list()) {
            console.log(
              [
                user.username,
                user.displayName,
                ROLE_LABELS[user.role],
                user.disabled ? "已停用" : "启用",
              ].join("\t"),
            );
          }
          return;
        }
        if (!username) throw new UsageError("缺少用户名");
        if (action === "add") {
          const role = values.role ?? "";
          if (!isRole(role)) throw new UsageError(`--role 必须是 ${ROLES.join("、")} 之一`);
          const displayName = values.name?.trim();
          if (!displayName) throw new UsageError("缺少 --name <姓名>");
          if (await users.byUsername(username)) throw new UsageError(`用户名 ${username} 已存在`);
          const password = generatePassword();
          await users.create({
            username,
            displayName,
            role,
            passwordHash: await hashPassword(password),
          });
          console.log(
            `已创建 ${username}（${displayName}，${ROLE_LABELS[role]}）。初始密码：${password}`,
          );
          console.log("请把初始密码安全地交给本人，登录后在“账户”页修改。");
          return;
        }
        const user = await users.byUsername(username);
        if (!user) throw new UsageError(`没有用户 ${username}`);
        switch (action) {
          case "reset-password": {
            const password = generatePassword();
            await users.setPassword(user.id, await hashPassword(password));
            console.log(`已重置 ${username} 的密码，原有登录已失效。新密码：${password}`);
            return;
          }
          case "role": {
            const role = extra ?? "";
            if (!isRole(role)) throw new UsageError(`角色必须是 ${ROLES.join("、")} 之一`);
            await users.setRole(user.id, role);
            console.log(`${username} 的角色已改为 ${ROLE_LABELS[role]}`);
            return;
          }
          case "disable":
          case "enable":
            await users.setDisabled(user.id, action === "disable");
            console.log(`${username} 已${action === "disable" ? "停用" : "启用"}`);
            return;
          default:
            throw new UsageError(`未知的 user 子命令 ${action ?? ""}`);
        }
      });
      return;
    }

    default:
      throw new UsageError(`未知命令 ${command}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
