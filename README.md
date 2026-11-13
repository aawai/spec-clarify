# spec-clarify

把 Markdown 审核文档拆成条目，交给产品方在线逐条澄清，工程方可以追问，所有记录只追加、可导出。一个站点可以同时澄清多份审核文档。自托管，单个 Node.js 进程加一个 SQLite 文件。

A self-hosted site that turns a Markdown review of your specs into items for product owners to clarify one by one, with an append-only, exportable record. The UI is in Chinese.

- 条目内容以仓库里的审核文档为准，站点只保存澄清与讨论；文档改动后刷新即可，无需重启。
- 审核意见中的 `文件:行号` 可点击，跳到源文档对应行并高亮；条目页同时在“原文对照”中按文档并排列出被引用的行及上下各 3 行，冲突的两处原文不用分别打开即可对照。
- 文档链接优先显示一级标题；审核文档配置了 `title` 时使用配置标题。无标题时显示路径，标题重复时附加路径以便区分；链接仍按路径和行号定位。
- 条目在澄清后被修改，自动标为“需复核”；工程方追问后、产品方回复前，标为“待回复”。
- 账号登录，角色分为产品、工程、管理员；只有产品和管理员能提交澄清。
- 页面不运行任何脚本，CSP 严格；样式来自本地提供的 [HeroUI](https://heroui.com) 预编译 CSS。

## 快速开始

需要 Node.js 24 或更高版本。

```sh
npm install --save-dev github:aawai/spec-clarify
```

npm 12 默认禁止 git 依赖，需要先在项目的 `.npmrc` 中加入 `allow-git=root`。安装时 npm 会构建 `dist/`。建议在 `package.json` 中把依赖固定到发布 tag 或某个提交，例如 `github:aawai/spec-clarify#v0.1.5`。

在项目根目录写 `spec-clarify.config.json`，按[审核文档格式](#审核文档格式)写好审核文档，然后：

```sh
npx spec-clarify check                                     # 校验配置与审核文档
npx spec-clarify user add admin --name 张三 --role admin   # 打印初始密码
npx spec-clarify serve                                     # http://127.0.0.1:3100
```

试用示例项目：

```sh
git clone https://github.com/aawai/spec-clarify && cd spec-clarify
npm install
npx tsx src/cli.ts user add demo --name 演示 --role product -c examples/basic/spec-clarify.config.json
npm run dev
```

## 配置

`spec-clarify.config.json`，所有路径相对于配置文件所在目录：

| 字段                  | 默认值                 | 说明                                                                  |
| --------------------- | ---------------------- | --------------------------------------------------------------------- |
| `title`               | `规格澄清`             | 站点名称，显示在页头、页面标题和导出文件中                            |
| `documents`           | `[]`                   | 源文档的 glob 列表，例如 `["specs/**/*.md"]`；审核文档自动加入        |
| `revisions`           | `[]`                   | 有序的源文档修订集（稀疏覆盖目录），每项含 `id`、`label`、`dir`       |
| `reviews`             | 必填，至少一项         | 本站点澄清的审核文档列表，每项字段见下表                              |
| `severities`          | `[]`                   | 严重度从高到低，例如 `["阻塞", "高", "中", "低"]`；决定颜色与筛选顺序 |
| `database`            | `data/spec-clarify.db` | SQLite 文件；一个数据库对应一个项目                                   |
| `trustDocumentHtml`   | `false`                | 渲染源文档中的原始 HTML；只对可信文档开启                             |
| `allowExternalImages` | `false`                | 允许源文档加载外部图片                                                |

`reviews` 的每一项：

| 字段      | 默认值              | 说明                                                          |
| --------- | ------------------- | ------------------------------------------------------------- |
| `path`    | 必填                | 审核文档路径，须在项目目录内，不能重复                        |
| `title`   | 文档的 `#` 一级标题 | 有多份审核文档时，导航和导出按它把分组归到各自文档下          |
| `adapter` | `markdown`          | 审核文档格式：`markdown`（默认格式）或 `prd-review`（见下文） |
| `options` | —                   | 适配器选项                                                    |

`revisions` 的每一项：

| 字段    | 默认值 | 说明                                                                |
| ------- | ------ | ------------------------------------------------------------------- |
| `id`    | 必填   | 修订版标识（仅限字母、数字、`_`、`-`），项目内唯一，用于 URL 与引用 |
| `label` | 必填   | 界面展示名称，例如 `V1`                                             |
| `dir`   | 必填   | 修订目录路径，须在项目目录内且不与 `reviews` 或其他修订目录重叠     |

配置 `revisions` 后：

- `documents` 会自动排除各 `revisions[].dir` 下的文件；短文件名（如 `login.md:12`）始终锚定基线版本，不因修订版出现同名文件而失效。
- 修订目录中只需放置相对基线有变更或新增的同名文件；文档阅读页提供版本切换与纯 HTML 增量 Diff 视图（默认对比上一修订版，无更早修订时对比基线）。
- 审核正文与澄清/评论正文均支持无行号文档路径（如 `specs/v1/login.md`）与 `@/specs/v1/login.md` 前缀，并直接生成可点击链接。

```json
{
  "documents": ["specs/**/*.md"],
  "reviews": [
    { "path": "reviews/product.md", "title": "产品审核" },
    { "path": "reviews/security.md", "title": "安全审核" }
  ]
}
```

多份审核文档共用一套账号、进度和导出。条目编号必须在**所有**审核文档中唯一：澄清记录只按编号保存，重复时站点拒绝加载并指出两处位置。“相关”可以引用其他审核文档的条目。任意一份审核文档无法解析，整个站点都会暂停。

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

- `##` 是分组，分组内每个 `###` 是一个条目，标题必须以编号开头。编号在站点的所有审核文档中唯一，发布后不再改动：澄清记录按编号保存。
- 标题后的 `- 键：值` 列表是元数据：`严重度`、`文档`（不带文件名的 `:行号` 指向它）、`相关`，其余键作为字段显示。
- 行号引用：`specs/login.md:12`、`:12`、`:12–20`、`:12、15`、`图@:12`。

完整约定见 [`skills/spec-clarify-review/SKILL.md`](skills/spec-clarify-review/SKILL.md)。它同时是一份 Agent Skill：复制到其他项目的技能目录（例如 `.claude/skills/spec-clarify-review/`），AI 助手就能按约定生成和修订审核文档。

### `prd-review` 适配器

兼容一种中文“PRD 审核报告”版式：第 2–5 节为跨模块的矛盾、风险、共享规则（`### G<n>` 段落）与参数表；附录 `### A.<n> <文件>.md` 下的“问题清单”“图中独有的规则”“图文冲突”“需产品决策的问题”成为各模块分组。后三类条目编号为 `<前缀>-F<#>`、`<前缀>-X<#>`、`<前缀>-Q<序号>`，取自表格的 `#` 列或列表序号，前缀由选项配置：

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

| 角色            | 澄清 | 评论 / 追问 |
| --------------- | ---- | ----------- |
| `product` 产品  | ✓    | ✓           |
| `admin` 管理员  | ✓    | ✓           |
| `engineer` 工程 | —    | ✓           |

账号由命令行管理，密码随机生成并只显示一次：

```sh
npx spec-clarify user add <用户名> --name <姓名> --role <admin|product|engineer>
npx spec-clarify user reset-password <用户名>   # 同时结束该账号所有登录
npx spec-clarify user role <用户名> <角色>
npx spec-clarify user disable <用户名>          # 同时结束该账号所有登录
npx spec-clarify user enable <用户名>
npx spec-clarify user list
```

用户登录后可在“账户”页修改密码，其他设备上的登录随之失效。会话有效期 30 天。同一用户名连续 5 次登录失败后锁定 15 分钟（计数保存在进程内存中，重启清零）。

## 澄清规则

- **澄清**改变条目状态；**评论 / 追问**只追加讨论。条目状态：未澄清 → 已澄清；条目内容在澄清后被修改则为需复核。另有“待回复”标记：最近一次澄清之后又有评论。
- 记录只追加，数据库触发器拒绝修改和删除。更正澄清就再提交一次。
- 产品和管理员的条目列表默认显示“待处理”：未澄清、需复核或待回复的条目，同一条目只显示一次，按配置的严重度从高到低排列；可切换“全部”及其他状态筛选。工程角色默认查看全部条目。
- 条目页的“提交并下一条”在提交澄清后直接打开当前筛选结果中的下一条，保留筛选条件，并显示上一条提交成功的回执；已是最后一条时停留在本条。
- 澄清和评论是不同的表单：澄清改变条目状态，评论仅追加讨论；已有澄清可展开更新，工程角色可直接发表评论。
- 并发保护：打开页面后别人提交了新的澄清，你的提交会被拒绝并保留草稿；条目在你打开页面后被修改，提交同样被拒绝。
- 审核文档无法解析时（例如编号重复），所有页面与提交暂停并显示错误位置，修复后刷新即恢复，避免把记录挂到错误的条目上。

## 导出

站内点“导出记录”，或：

```sh
npx spec-clarify export -o docs/clarifications.md
```

导出包含各分组状态汇总、每个条目的当前澄清，以及有记录条目的完整历史；已从审核文档删除的条目，其历史单独列在末尾。时间按服务器时区格式化，部署时设置 `TZ`，例如 `TZ=Asia/Shanghai`。

## 部署

```sh
TZ=Asia/Shanghai npx spec-clarify serve --config /srv/project/spec-clarify.config.json
```

| 选项               | 环境变量                        | 默认值    |
| ------------------ | ------------------------------- | --------- |
| `--host`           | `SPEC_CLARIFY_HOST`             | `0.0.0.0` |
| `--port`           | `SPEC_CLARIFY_PORT`             | `3100`    |
| `--secure-cookies` | `SPEC_CLARIFY_SECURE_COOKIES=1` | 关闭      |

- 默认监听所有网卡；只允许本机访问（例如由同机反向代理转发）时使用 `--host 127.0.0.1`。
- 经公网或不可信网络访问时，放在提供 HTTPS 的反向代理之后，并开启 `--secure-cookies`。
- 数据库使用 WAL 模式。备份用 SQLite 在线备份（`sqlite3 data/spec-clarify.db ".backup backup.db"`），不要只复制主文件；也可以定期导出记录纳入版本控制。
- 每次请求都重新读取源文档与审核文档，`git pull` 后刷新页面即可。
- 浏览器声明支持时，页面与样式以 gzip 压缩传输（数百个条目的列表页未压缩可达数百 KB）；前置反向代理时无需再另行开启压缩。
- `Ctrl+C` 或 `SIGTERM` 关闭服务与数据库后退出。

## 开发

```sh
npm install
npm run dev          # 示例项目，http://127.0.0.1:3100
npm test
npm run typecheck
npm run lint
npm run format
npm run build
```

## 许可证

[Apache-2.0](LICENSE)
