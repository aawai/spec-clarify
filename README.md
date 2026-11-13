# spec-clarify

把 Markdown 审核文档拆成条目，交给产品方在线逐条澄清，工程方可以评论追问并标记已落地，所有记录只追加、可导出，也可通过 MCP 供 AI 助手读取与回执。一个站点可以同时澄清多份审核文档，自托管在单个 Node.js 进程与一个 SQLite 文件中。

A self-hosted site that turns one or more Markdown reviews of your specs into items for product owners to clarify one by one, with engineering follow-ups, revision diffs, MCP access, and an append-only, exportable record. The UI is in Chinese.

- **实时读取文档**：条目与源文档以仓库文件为准，站点只保存澄清、评论与已落地回执；文档改动后刷新页面即可生效，无需重启。
- **原文定位与对照**：审核意见中的 `文件:行号` 与文档路径可点击跳转到源文档并高亮；条目页在“原文对照”中按文档并排列出引用行及上下各 3 行上下文，便于直接对照冲突原文。
- **源文档修订对比**：支持配置多版本修订目录（`revisions`），提供版本切换与纯服务端渲染的变更对比（Diff）视图。
- **智能链接标题**：文档链接优先显示一级标题；审核文档配置了 `title` 时使用配置标题。无标题时显示路径，标题重复时附加路径区分；链接仍按路径和行号定位。
- **清晰的状态流转**：条目在澄清后被修改会自动标为“需复核”；工程方追问后、产品方回复前标为“待回复”；已澄清条目可进一步标记“已落地”。
- **角色与安全边界**：账号登录分产品、工程、管理员角色；页面不运行任何客户端脚本，CSP 严格，样式来自本地提供的 [HeroUI](https://heroui.com) 预编译 CSS。
- **MCP 与命令行**：内置只读与可选回执写入的 MCP 服务，以及校验、导出、账号管理和内置 Skill 安装命令。

## 快速开始

需要 Node.js 24 或更高版本。

```sh
npm install --save-dev github:aawai/spec-clarify
```

npm 12 默认禁止 git 依赖，需要先在项目的 `.npmrc` 中加入 `allow-git=root`。安装时 npm 会自动构建 `dist/`。建议在 `package.json` 中将依赖固定到发布 tag（例如 `github:aawai/spec-clarify#v0.1.8`）或具体提交；本文包含的 MCP 服务、已落地回执与 `skill` 命令等最新能力需使用包含相应提交的版本或后续发布 tag。

在项目根目录编写 `spec-clarify.config.json`，按[审核文档格式](#审核文档格式)准备审核文档后运行：

```sh
npx spec-clarify check                                     # 校验配置、源文档与审核文档
npx spec-clarify user add admin --name 张三 --role admin   # 创建管理员账号并打印初始密码
npx spec-clarify serve                                     # 启动站点，默认 http://127.0.0.1:3100（监听 0.0.0.0）
```

试用仓库自带的示例项目：

```sh
git clone https://github.com/aawai/spec-clarify && cd spec-clarify
npm install
npx tsx src/cli.ts user add demo --name 演示 --role product -c examples/basic/spec-clarify.config.json
npm run dev
```

使用上面打印的初始密码登录 `http://127.0.0.1:3100` 即可体验。

## 协作流程

1. **编写与校验**：审核人员或 AI 助手（可先通过 `npx spec-clarify skill install` 安装写作规范 Skill）编写审核文档，执行 `npx spec-clarify check` 确认编号唯一与格式正确。
2. **启动与建号**：管理员配置 `spec-clarify.config.json`，通过 `user add` 创建产品、工程账号并启动 `serve`。
3. **澄清与讨论**：产品方在“待处理”队列逐条提交澄清；工程方查阅原文对照与版本变更，有疑问时发表评论追问（条目标为“待回复”），待产品方更新澄清。
4. **落地与回执**：工程方或 AI 助手通过[导出](#导出)或 [MCP 服务](#mcp-服务)获取澄清结论并修改文档/代码，再通过站内“标记已落地”、`spec-clarify ack` 或 MCP `resolve_items` 绑定当前澄清 ID 留痕。

## 配置

默认读取当前目录下的 `spec-clarify.config.json`（可通过 `-c` / `--config` 指定路径）。配置文件采用严格校验（不接受未定义字段），其中所有相对路径均相对于配置文件所在目录：

| 字段                  | 默认值                 | 说明                                                                           |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `title`               | `规格澄清`             | 站点名称，显示在页头、页面标题和导出文件中                                     |
| `documents`           | `[]`                   | 源文档的 glob 列表，例如 `["specs/**/*.md"]`；审核文档与修订目录处理见下文     |
| `revisions`           | `[]`                   | 有序的源文档修订集（稀疏覆盖目录），详见[源文档修订集](#源文档修订集revisions) |
| `reviews`             | 必填，至少一项         | 本站点澄清的审核文档列表，每项字段见下表                                       |
| `severities`          | `[]`                   | 严重度从高到低，例如 `["阻塞", "高", "中", "低"]`；决定颜色与“待处理”视图排序  |
| `database`            | `data/spec-clarify.db` | SQLite 文件路径（支持相对或绝对路径）；一个数据库对应一个项目                  |
| `trustDocumentHtml`   | `false`                | 渲染源文档中的原始 HTML；默认按纯文本转义显示，仅对完全可信的文档开启          |
| `allowExternalImages` | `false`                | 允许源文档加载外链图片；默认仅允许同源与 `data:` 图片（受 CSP 限制）           |

`reviews` 每一项：

| 字段      | 默认值              | 说明                                                          |
| --------- | ------------------- | ------------------------------------------------------------- |
| `path`    | 必填                | 审核文档路径，须在项目目录内，不能重复                        |
| `title`   | 文档的 `#` 一级标题 | 有多份审核文档时，导航和导出按它把分组归到各自文档下          |
| `adapter` | `markdown`          | 审核文档格式：`markdown`（默认格式）或 `prd-review`（见下文） |
| `options` | —                   | 适配器选项（`prd-review` 适配器必填）                         |

多份审核文档示例：

```json
{
  "documents": ["specs/**/*.md"],
  "reviews": [
    { "path": "reviews/product.md", "title": "产品审核" },
    { "path": "reviews/security.md", "title": "安全审核" }
  ]
}
```

多份审核文档共用一套账号、进度和导出。条目编号必须在**所有**审核文档中唯一：澄清记录只按编号保存，重复时站点拒绝加载并指出两处位置。“相关”可以跨文档引用条目。任意一份审核文档无法解析，整个站点都会暂停。

### 源文档修订集（`revisions`）

配置 `revisions` 后，可以在同一站点中对比多版源文档的变更：

| 字段    | 默认值 | 说明                                                                            |
| ------- | ------ | ------------------------------------------------------------------------------- |
| `id`    | 必填   | 修订版标识（仅限字母、数字、`_`、`-`），项目内唯一，用于 URL 与文档引用         |
| `label` | 必填   | 界面展示名称，例如 `V1`                                                         |
| `dir`   | 必填   | 修订目录路径，须在项目目录内（不能为 `.`），且不与 `reviews` 或其他修订目录重叠 |

使用规则与路径映射：

- `documents` 会自动排除各 `revisions[].dir` 下的文件，审核文档本身也会自动加入文档列表。
- 修订目录中只需放置相对基线有变更或新增的 `.md` 文件（固定扫描目录内 `**/*.md`）。修订文件通过两种方式匹配基线文件：修订目录内相对路径 `relPath` 与基线路径一致，或 `dirname(rev.dir) + "/" + relPath` 与基线路径一致。推荐以下两种目录组织方式之一：

```text
# 方式 A：修订目录与基线文档同级（specs/v1 下的 login.md 匹配 specs/login.md）
specs/login.md
specs/v1/login.md

# 方式 B：独立修订根目录（revisions/v1 下的 specs/login.md 匹配 specs/login.md）
specs/login.md
revisions/v1/specs/login.md
```

- 短文件名（如 `login.md:12`）始终只锚定基线版本与审核文档，不会因修订版出现同名文件而产生歧义失效。
- 文档阅读页提供版本切换与纯服务端渲染的变更对比（Diff）视图（默认对比上一存在该文件的修订版，无更早修订时对比基线）。

## 审核文档格式

```md
## 登录

### L1 锁定时长未定义

- 严重度：高
- 文档：specs/login.md
- 相关：L2
- 建议：补充锁定时长

:7 规定输错 5 次锁定，但没有写锁定多久。
```

- **分组与条目**：`##` 开启一个分组，分组内每个 `###` 是一个条目，格式为 `### <编号> <标题>`。第一个 `##` 之前以及分组与第一个条目之间的说明文字不会被解析为条目；`####` 及更深标题、围栏代码块内的 `#` 属于正文内容。
- **编号约束**：编号必须以英文字母开头，只能包含英文字母、数字、`_`、`-`（正则 `^[A-Za-z][A-Za-z0-9_-]*$`，不能含中文、`.` 或空格），在项目所有审核文档中唯一，发布后不再改动。
- **元数据列表**：紧跟在条目标题后（中间允许空行）的连续 `- 键：值` 列表为元数据（支持全角 `：` 或半角 `:`，键长 1–20 字符）。内建键为 `严重度` / `severity`、`文档` / `document`（不带文件名的 `:行号` 默认指向它）、`相关` / `related`；其余键作为字段显示。第一个空行或非元数据行开始正文，正文中的列表不再当作元数据。

### 行号与文档引用

审核意见、字段值以及澄清/评论正文中均支持以下引用语法（行内代码与已有 Markdown 链接内不转换），未命中或行号越界时保持纯文本：

| 写法                 | 说明                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| `specs/login.md:12`  | 指向该文件第 12 行；文件名在基线/审核文档中唯一时也可简写为 `login.md:12`             |
| `v1/login.md:12`     | 指向修订版 `id` 为 `v1` 的对应文件第 12 行（也支持完整路径如 `specs/v1/login.md:12`） |
| `specs/login.md`     | 无行号文档路径（同时支持 `@/specs/login.md` 前缀与修订路径）                          |
| `:12`                | 指向当前分句已出现的显式文件，否则回退到条目 `文档` 元数据指定的文件                  |
| `:12–20` 或 `:12-20` | 行范围                                                                                |
| `:12、15、20–22`     | 同一文件的多处位置                                                                    |
| `图@:12`             | 带 1–4 字符标签的引用（也可写 `图@login.md:12`）                                      |

`；`、`;` 或段落结束会重置当前分句的文件上下文，之后的 `:行号` 回到条目默认文档。

完整约定见 [`skills/spec-clarify-review/SKILL.md`](skills/spec-clarify-review/SKILL.md)。它同时是一份 Agent Skill，安装后即可由 AI 助手按约定生成和修订审核文档：

```sh
npx spec-clarify skill install                                    # 默认写入 .agents/skills/spec-clarify-review
npx spec-clarify skill install --target .claude/skills/spec-clarify-review
```

也可通过 `npx skills add aawai/spec-clarify` 安装，或用 `npx spec-clarify skill path` 查看包内 Skill 路径后自行软链接。

### `prd-review` 适配器

兼容一种中文“PRD 审核报告”版式：

- 第 2–5 节（`## 2. …` 至 `## 5. …`）为跨模块的矛盾、风险、共享规则（`### G<n> 标题` 段落）与工程默认参数表，表格须包含 `ID` 或 `#` 列。
- 附录 `### A.<n> <文件>.md` 下的 `####` 子节“问题清单”“图中独有的规则”“图文冲突”“需产品决策的问题”成为各模块分组。“问题清单”取表格 `ID` 列；后三类自动编号为 `<前缀>-F<#>`、`<前缀>-X<#>`、`<前缀>-Q<序号>`，取自表格 `#` 列或有序列表序号。
- 必须配置 `options.modules` 为所有出现的 `<文件>.md` 指定大写英文字母前缀（键须以 `.md` 结尾，前缀匹配 `^[A-Z]+$`）：

```json
{
  "reviews": [
    {
      "path": "docs/prd-review.md",
      "adapter": "prd-review",
      "options": { "modules": { "login.md": "L", "account.md": "A" } }
    }
  ]
}
```

## 账号与角色

| 角色            | 澄清 | 评论 / 追问 | 标记已落地 |
| --------------- | ---- | ----------- | ---------- |
| `product` 产品  | ✓    | ✓           | ✓          |
| `admin` 管理员  | ✓    | ✓           | ✓          |
| `engineer` 工程 | —    | ✓           | ✓          |

账号通过命令行创建与管理（密码由系统随机生成，只在创建或重置时打印一次）；用户登录后可在“账户”页修改密码（不少于 8 位），改密后其他设备上的登录会话随之失效。会话有效期 30 天；同一用户名连续 5 次登录失败后锁定 15 分钟（失败计数保存在进程内存中，重启清零）。

## 澄清规则

- **状态与讨论**：**澄清**改变条目状态（未澄清 → 已澄清；条目内容在澄清后被修改则为需复核）；**评论 / 追问**仅追加讨论，在尚未通过新澄清回复前条目标为“待回复”（包括未澄清条目下的评论）。
- **只追加存储**：数据库触发器拒绝 `UPDATE` 和 `DELETE`。如需更正澄清，再次提交新版本即可；删除审核文档中的条目不会删除其历史记录。
- **已落地标记**：已澄清的条目可通过站内“标记已落地”、`spec-clarify ack` 或 MCP `resolve_items` 绑定当前澄清 ID 标记为“已落地”；若产品方随后提交新澄清或条目内容变更需复核，标记自动失效，避免遗漏后续批次。也可通过“取消已落地”或 `spec-clarify reopen` 重新打开。
- **队列与分页**：产品和管理员的条目列表默认显示“待处理”（未澄清、需复核或待回复条目，去重后按配置的 `severities` 从高到低排列），工程角色默认查看“全部”；可按分组、状态、严重度与关键词筛选，每页 50 条（`?page=`），切换筛选条件时自动回到第 1 页。
- **连续处理**：详情页存在后续匹配条目时提供“提交并下一条”（更新时为“更新并下一条”），提交后直接打开当前筛选结果中的下一条并保留筛选条件与页码，顶部显示上一条提交回执；已是最后一条时仅显示“提交澄清”或“更新澄清”，提交后停留在本条。
- **表单行为**：初次澄清表单默认展开；已有澄清在“待回复”或“需复核”时自动展开“更新澄清”（支持一键载入上一版正文）；评论框常驻显示以便随时追问。
- **原文对照**：引用范围超过 40 行时，原文对照自动展示首尾各 20 行，中间省略部分可点击跳转到文档对应位置。
- **并发保护**：浏览或填写澄清期间，若其他成员提交了新澄清或审核文档中的条目内容发生修改，当前提交会被返回 409 并拒绝覆盖，系统会保留草稿并展示对方最新澄清摘要。
- **键盘快捷操作**：原生 `accesskey`（无客户端脚本，需配合浏览器修饰键，如 macOS 下 `Control+Option+键`、Windows/Linux 下 `Alt+键`）：`q` 聚焦列表搜索框，`c` 聚焦详情页输入框（产品/管理员为澄清框，工程为评论框），`p` 上一页 / 上一条，`n` 下一页 / 下一条，`s` 提交（或更新）并进入下一条；详情页顶部另提供键盘跳过链接直达输入区。
- **源文档故障保护**：任意源文档或审核文档无法读取或解析时（如编号重复），所有页面、提交与导出返回 503 并指出错误位置，修复后刷新即恢复，避免把记录挂到错误条目上。

## 导出

在站内点击顶栏「导出记录」（导出全项目**全部条目**，不受列表筛选条件影响），或执行：

```sh
npx spec-clarify export -o docs/clarifications.md
```

省略 `-o` 时直接输出到标准输出。导出文件包含各分组状态汇总、每个条目的当前澄清与已落地状态、有记录条目的完整澄清/评论及落地回执历史；已从审核文档删除的条目，其澄清与评论历史单独列在末尾。时间按服务器时区格式化，部署时可设置 `TZ`（如 `TZ=Asia/Shanghai`）。

## MCP 服务

提供 MCP（Model Context Protocol）服务，供 AI 助手直接按条件查询澄清结论、条目原文对照与源文档修订差异，默认只读，可选开启落地回执写入：

- **本地模式（stdio）**：在项目根目录 `.mcp.json` 中加入（或运行 `npx spec-clarify mcp --print-config` 生成；加 `--write` 可启用 `resolve_items`）：

```json
{
  "mcpServers": {
    "spec-clarify": {
      "command": "npx",
      "args": ["spec-clarify", "mcp", "-c", "spec-clarify.config.json"]
    }
  }
}
```

- **远程模式（Streamable HTTP）**：启动站点时通过 `--mcp-token <令牌>` 或 `SPEC_CLARIFY_MCP_TOKEN` 启用 `/mcp` 端点（未配置令牌时默认关闭；如需允许远程 AI 回写“已落地”回执，再加 `--mcp-write` 或 `SPEC_CLARIFY_MCP_WRITE=1`）。客户端配置示例（如所用客户端不支持 `${...}` 环境变量替换，请填写实际令牌）：

```json
{
  "mcpServers": {
    "spec-clarify": {
      "type": "http",
      "url": "https://clarify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${SPEC_CLARIFY_MCP_TOKEN}"
      }
    }
  }
}
```

内置工具：

- **只读工具**：
  - `list_items`：按状态（`all` / `pending` / `open` / `clarified` / `stale` / `awaiting`）、已落地状态（`applied`）、分组、严重度、关键词及 `afterClarificationId` 游标筛选条目。
  - `get_item`：单条完整审核意见、澄清与评论历史、落地回执、关联条目与原文对照片段。
  - `list_documents`：列出全部源文档与审核文档，及各修订版增删统计。
  - `get_document`：读取指定版本原文（带行号，自动处理未修改文件的版本继承）。
  - `diff_document`：输出修订版对比的纯文本 Unified Diff。
- **可选写入工具**（需 `mcp --write` 或 `serve --mcp-write`）：
  - `resolve_items`：批量标记 `applied`（已落地）或 `reopened`（重新打开），支持传入 `clarificationId` 防止覆盖期间新增的澄清。

多批澄清处理时，AI 只需调用 `list_items(status="clarified", applied=false)` 获取尚未落地的澄清条目，处理完成后调用 `resolve_items`（或本地执行 `spec-clarify ack`）即可避免下次重复处理。

## 命令行参考

所有子命令均支持通用选项 `-c, --config <文件>`（默认 `./spec-clarify.config.json`）与 `-h, --help`：

| 命令                                                                                   | 说明                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `spec-clarify serve [选项]`                                                            | 启动 HTTP 站点（选项与环境变量见[部署](#部署)）                                         |
| `spec-clarify check`                                                                   | 校验配置、源文档、修订目录与审核文档                                                    |
| `spec-clarify export [-o <文件>]`                                                      | 导出全项目澄清记录为 Markdown（默认输出到标准输出）                                     |
| `spec-clarify ack <编号...> [--clarification <ID>] [--by <操作人>] [--note <说明>]`    | 标记指定条目的最新澄清已落地（`--clarification` 仅支持同时指定单个条目编号）            |
| `spec-clarify reopen <编号...> [--clarification <ID>] [--by <操作人>] [--note <说明>]` | 取消已落地标记，使条目重新进入待落地队列                                                |
| `spec-clarify mcp [--write] [--print-config]`                                          | 以 stdio 模式启动 MCP 服务，或打印 `.mcp.json` 配置片段                                 |
| `spec-clarify skill path` / `install [--target <目录>]`                                | 打印内置 Skill 目录路径，或安装/更新 Skill（默认 `.agents/skills/spec-clarify-review`） |
| `spec-clarify user add <用户名> --name <姓名> --role <admin\|product\|engineer>`       | 创建账号并打印初始密码                                                                  |
| `spec-clarify user reset-password <用户名>`                                            | 重置密码并打印新密码，同时结束该账号所有已登录会话                                      |
| `spec-clarify user role <用户名> <admin\|product\|engineer>`                           | 修改账号角色                                                                            |
| `spec-clarify user disable <用户名>` / `enable <用户名>`                               | 停用（并注销所有会话）或启用账号                                                        |
| `spec-clarify user list`                                                               | 列出所有账号                                                                            |

## 部署

```sh
TZ=Asia/Shanghai npx spec-clarify serve --config /srv/project/spec-clarify.config.json
```

| 选项               | 环境变量                        | 默认值    |
| ------------------ | ------------------------------- | --------- |
| `--host`           | `SPEC_CLARIFY_HOST`             | `0.0.0.0` |
| `--port`           | `SPEC_CLARIFY_PORT`             | `3100`    |
| `--secure-cookies` | `SPEC_CLARIFY_SECURE_COOKIES=1` | 关闭      |
| `--mcp-token`      | `SPEC_CLARIFY_MCP_TOKEN`        | 关闭      |
| `--mcp-write`      | `SPEC_CLARIFY_MCP_WRITE=1`      | 关闭      |

- 默认监听所有网卡（`0.0.0.0`）；仅限本机访问或前面有同机反向代理时，建议使用 `--host 127.0.0.1`。
- 经公网或不可信网络访问时，放在提供 HTTPS 的反向代理之后，并开启 `--secure-cookies`；反向代理需正确透传 `Host` 头以配合表单同源 CSRF 校验。
- 数据库使用 WAL 模式。备份请使用 SQLite 在线备份（`sqlite3 data/spec-clarify.db ".backup backup.db"`），不要直接复制单个主文件；也可定期导出 Markdown 纳入版本控制。
- 每次请求都会重新读取源文档与审核文档，`git pull` 更新文档后刷新页面即可。
- 浏览器支持时，页面与样式默认以 gzip 压缩传输；前置反向代理时无需重复压缩。
- 发送 `Ctrl+C`（`SIGINT`）或 `SIGTERM` 会先关闭 HTTP 服务和数据库连接后退出。

## 开发与库 API

本地开发：

```sh
npm install
npm run dev          # 启动示例项目，http://127.0.0.1:3100
npm test             # 运行测试
npm run typecheck    # TypeScript 类型检查
npm run lint         # Oxlint 检查
npm run format:check # Oxfmt 格式检查（npm run format 自动格式化）
npm run build        # 构建 dist/
```

### 库 API（文档校验集成）

`spec-clarify` 导出配置文件与工作区解析接口，可用于在下游项目的测试或 CI 脚本中校验审核文档：

```ts
import { loadProjectConfig, loadWorkspace, SourceError } from "spec-clarify";

const config = await loadProjectConfig("spec-clarify.config.json");
const workspace = await loadWorkspace(config); // 解析或读取失败时抛出 SourceError
console.log(workspace.review.items.length);
```

## 许可证

[Apache-2.0](LICENSE)
