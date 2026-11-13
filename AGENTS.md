# 仓库指南

你是本仓库的 AI 编程助手。目标是独立完成可靠、可维护的实现，使人类主要关注 Specifications、Architecture、全局 Invariants 和高风险边界。

## 工程原则

- **Correctness first.** 优先满足 `Specification`、`Invariants` 和 external / public contract；其次遵循 Architecture 和 type model。
- **Determine the complete required scope.** 不要把“用户明确提到的内容”自动等同于完整需求。结合 specification、现有行为、领域模型和 contracts，识别使功能正确且自洽所必需的关联行为并一并纳入设计；与当前目标无关的改动不纳入。
- **Fix root causes.** 不使用 stopgap、Hack、workaround 或 special case 堆叠。不要为了减小 diff 或缩短实现时间而降低设计质量。
- **Reuse before adding.** 优先复用已有能力、标准库和成熟社区方案，避免重复实现。保留、改造或替换当前实现，均以满足项目契约与约束为依据；候选方案被否决不代表现状可接受。
- **Design completely, deliver incrementally.** 先确定完整的正确设计，再将大改动拆成可独立验证和回滚的 micro-increments。Increment 是交付边界，不是削减必要 scope 的理由。
- **Escalate only real conflicts.** 若 Specification、Invariants、Architecture、type model 或 contracts 无法同时满足，不要猜测；说明冲突、trade-off 和需要人类决定的最小问题。普通、可逆的工程决策自行判断。
- 现有实现不是设计正确性的证据；视觉例外必须定义新的系统级语义与验证边界，不以“已经这样实现”新增 raw visual value。

## 协作约定

- 默认使用简体中文，API、JSON、Token、Hook、Buffer 等通用技术术语保留英文。
- 结论与关键依据优先，使用具体、可验证的描述；仅在影响判断时展开风险、备选方案或下一步，不重复已知信息或套用固定模板。
- 能从代码、配置、文档或工具确认的信息先自行核实；普通工程细节自行判断，仅对无法自行解决的关键需求、架构或 contract 冲突询问。
- 区分事实、推断和未验证内容；风险说明触发条件、影响范围与依据，建议对应已确认的问题。
- 仓库变更完成时说明实际改动、验证结果，以及影响交付判断的未验证项；不把计划或未执行操作描述为已完成。

## 项目概述

- spec-clarify 是自托管的审核意见澄清站点：把一个项目的一份或多份 Markdown 审核文档拆成条目，产品方逐条澄清，工程方评论追问，记录只追加、可导出为 Markdown。界面为中文。
- 运行形态：单个 Node.js 进程加一个 SQLite 文件，一个配置文件 / 数据库对应一个项目；页面服务端渲染，不运行客户端脚本。
- 分发方式：Apache-2.0 公开仓库，使用方以 git 依赖安装并固定到发布 tag 或具体提交（安装时由 `prepare` 构建 `dist/`）；未发布到 npm，版本以 GitHub Release（tag `v<package.json 版本>`）发布，当前为 `v0.1.6`。
- 技术栈：TypeScript、Hono（`@hono/node-server`）、Zod、markdown-it、`@libsql/client`（SQLite）、`@heroui/styles` 预编译 CSS；Oxc 工具链使用 Oxlint、Oxfmt 和基于 Rolldown 的 tsdown，类型检查用 TypeScript `tsc`。

## 契约来源

- `README.md` 是面向使用者的契约：配置字段、审核文档格式、`prd-review` 适配器、角色权限、澄清规则、导出与部署、命令行用法。行为变化必须同步它。
- `skills/spec-clarify-review/SKILL.md` 是交给其他项目 AI 助手的审核文档编写约定，与默认 `markdown` 适配器、行号引用解析和配置 schema 必须一致；修改这些行为时同步更新它。
- `src/index.ts` 导出的库 API（`loadProjectConfig`、`loadWorkspace`、`SourceError` 及 `Review*` 类型）被下游项目用于校验自己的审核文档，属于公开 contract。
- 已部署项目的数据库文件、配置文件和审核文档都在使用方手里。当前不提供 schema 迁移（表在启动时以 `CREATE TABLE IF NOT EXISTS` 创建）；改动既有表结构、条目编号规则或 digest 语义会影响已有数据，先说明影响范围再决定，不静默改变。

## Invariants

- 澄清记录只按条目编号（`item_id`）保存：编号由作者在审核文档中显式书写，在一个项目的所有审核文档中唯一，不得按行序或位置生成；重复编号必须让整个项目加载失败并指出两处位置。
- `entries` 只追加：数据库触发器拒绝 `UPDATE` / `DELETE`；更正通过再提交一条记录实现。删除条目不删除其记录，导出文件在“已从审核文档移除的条目”中保留历史。
- 条目 digest 只随内容变化（标题、严重度、字段、正文、`文档` 元数据），空白、换行与表格对齐不影响；`相关` 不计入。澄清所基于的 digest 与当前不同即为“需复核”。
- 提交澄清必须携带页面上的 digest 与最近一次澄清的 ID（`base`）：任一不符返回 409 并保留草稿，不覆盖他人结论；评论不做此检查。
- 任意源文档或审核文档无法读取或解析时抛出 `SourceError`，所有页面、提交与导出返回 503，不展示旧数据、不写入。
- 权限在服务端强制：只有 `product`、`admin` 能提交澄清；未登录请求只能访问登录页与静态样式。会话令牌只存 SHA-256 摘要，密码使用 scrypt；停用账号或改密会结束相应会话。
- 页面不执行脚本（CSP `script-src 'none'`、`form-action 'self'`），表单经 CSRF Origin 校验；源文档原始 HTML 仅在 `trustDocumentHtml` 时渲染，审核文本永远不渲染原始 HTML。

## 架构与数据流

- `src/cli.ts`：命令行入口（`serve`、`check`、`export`、`user`），解析参数与 `SPEC_CLARIFY_*` 环境变量，打开数据库并启动 Hono 服务；收到退出信号时关闭服务和数据库。
- `src/project.ts`：用 Zod 校验 `spec-clarify.config.json`（路径相对配置文件）；`loadWorkspace` 每次调用都重新读取 `documents` glob、`revisions` 稀疏修订目录与全部 `reviews`，按配置的适配器解析，多份审核文档时把分组归到各自文档标题下，再交给 `buildReview` 合并；提供按精确路径或基线唯一文件名解析文档的 `resolve`。
- `src/review/model.ts`：`ReviewGroup` / `ReviewItem` 模型；`buildReview` 校验跨文档编号与分组键唯一、解析相关条目、计算 digest。
- `src/review/adapters/`：`markdown.ts`（默认格式）、`prd-review.ts`（中文 PRD 审核报告版式），在 `index.ts` 中以 Zod 选项 schema 注册；适配器只产出 `ParsedReview`，不做跨文档逻辑。
- `src/render/markdown.ts`：审核与澄清/评论文本渲染，以及 `文件:行号`、无行号路径和 `@/` 前缀引用链接（可收集已链接的引用）；源文档带行号标注与高亮的渲染。`src/render/excerpt.ts`：按引用截取源文档行及上下文，供条目页“原文对照”。`src/render/diff.ts`：纯服务端渲染的 Unified Diff（双栏行号、行内修改高亮与 `<details>` 折叠）。
- `src/clarification.ts`：由最近一次澄清与评论推导条目状态（未澄清 / 已澄清 / 需复核）与“待回复”。
- `src/store/`：`database.ts` 建库与 PRAGMA（WAL、外键、锁等待）；`users.ts` 账号与会话；`entries.ts` 记录、并发检查与活动汇总。
- `src/web/`：`app.ts` 路由、登录守卫、表单处理与错误页；`view.ts` 布局与共享组件；`style.ts` HeroUI 样式与站点 CSS（按内容哈希提供、长期缓存）。
- `src/export.ts`：导出 Markdown；`src/auth.ts`：密码哈希、会话令牌。
- 每个请求都重新加载工作区（文档改动刷新即生效，不缓存）；登录失败计数保存在 `createApp` 实例内存中，重启清零。

## 目录与关键文件

- `src/`：源代码与同目录测试（`*.test.ts`）；`src/index.ts` 库出口，`src/cli.ts` 可执行入口。
- `examples/basic/`：虚构的示例项目（两份审核文档、两份源文档），供 `npm run dev` 与 CI 校验使用。
- `skills/spec-clarify-review/SKILL.md`：审核文档编写约定（Agent Skill）。
- `README.md`、`CHANGELOG.md`、`LICENSE`；`.github/workflows/ci.yml`：CI 门禁。
- `package.json`、`package-lock.json`、`tsconfig.json`、`tsdown.config.ts`：依赖、命令、类型检查与构建配置。

## 开发命令

- 环境：Node.js `>=24`，使用 npm；`npm install` 会通过 `prepare` 执行一次构建。
- `npm run dev`：用 `examples/basic` 启动站点（监听 `0.0.0.0:3100`）；首次需先用 `npx tsx src/cli.ts user add … -c examples/basic/spec-clarify.config.json` 建账号。
- `npm run build`：tsdown 构建 `dist/cli.mjs`、`dist/index.mjs`、`dist/index.d.mts`。
- `npm run typecheck`：`tsc --noEmit`；`npm run lint`：Oxlint；`npm run format`、`npm run format:check`：Oxfmt（覆盖整个仓库，包括 Markdown 与 JSON）。
- `npm test`：Node.js 测试运行器通过 tsx 执行 `src/**/*.test.ts`。
- CI 依次执行 typecheck、lint、format:check、test、build，并用构建产物对示例项目执行 `check`。

## 代码约定与常用模式

- 使用 ESM 和 TypeScript strict 模式；相对模块导入使用 `.js` 扩展名。
- 站点是表单提交的服务端渲染 HTML，不是公开 HTTP API：使用普通 Hono 路由，表单与查询参数在边界用 Zod 校验；成功提交返回 303 重定向。状态码约定：输入无效 422，与较新状态冲突 409，无权限 403，条目或文档不存在 404，源文件不可用 503。
- 页面用 `hono/html` 模板，不引入 React、Tailwind 或客户端脚本；样式使用 `@heroui/styles` 预编译 CSS 的 BEM 类（如 `button button--primary`），站点专属布局写在 `src/web/style.ts`。
- 新增审核文档格式：在 `src/review/adapters/` 实现并在 `index.ts` 注册（含 Zod 选项 schema）；分组键以审核文档路径为前缀并设置 `source`，编号必须来自文档中的显式内容。同步更新 README，影响默认格式时同步 SKILL。
- 配置 schema 为 `strict`；新增字段需同时更新 README 配置表与 SKILL 中的配置说明。
- 界面文案、命令行输出使用简体中文；代码注释与错误消息使用英文。
- 测试与被测模块同目录（`src/**/*.test.ts`）；涉及文件系统或数据库的测试在临时目录中创建并在结束时删除。
- `oxfmt` 会格式化 `examples/` 中的 Markdown；修改示例后核对审核文档中的 `文件:行号` 引用仍指向正确行。

## 测试与验证

### 范围与契约

- 以最小充分证据证明外部可观察契约。修改前确认受影响行为与既有覆盖，
  优先复用、迁移现有测试；不以测试数量或执行轮数衡量充分性。
  添加测试前必须能回答：“失败时，用户或下游消费者会观察到什么回归？”
- 业务逻辑、数据转换、state management、API、parser、protocol 和 Bug 修复
  默认采用 **Contract → Red → Green → 必要时 Refactor**。
  选择能保护契约的最低层级：适配器解析、引用渲染、状态推导、存储并发优先 unit/module tests；
  登录、权限、表单流程与错误页用 `createApp` 的 `app.request` 测试；界面布局变化用浏览器实际查看。
  不同层级仅为独立风险保留必要重叠。
- 不测试无业务意义的实现细节、静态回显、passthrough、非空/长度增长、内部 wiring，
  或已有测试充分覆盖的相同契约。测试应确定、隔离，并能安全加入完整套件。
- 纯 formatting、comment、type-only change、不改变行为的 rename，
  以及已有契约测试覆盖的内部重构，通常无需新增测试。
  文档、注释等不改变运行时行为的修改，不单独触发浏览器验证；既有 CI 门禁照常执行。
- 明确列举的验收场景逐项覆盖；仅列出维度时，按执行路径、边界与交互风险选择代表组合，
  不机械执行全组合。

### 执行与调度

- 从最接近变更的验证开始：**focused tests → `npm test` → typecheck →
  lint/format → build 与示例项目 `check` → 必要时浏览器冒烟**。
  这是覆盖不足时的升级路径，不是每个任务必须逐级执行的清单。
  影响共享行为、影响面不确定或局部证据不足时扩大范围；CI 门禁不得省略。
- 改动安装或构建方式（`package.json` 的 `files` / `exports` / `bin` / `prepare`、tsdown 配置）时，
  在临时目录以 git 依赖方式实际安装一次，确认 `dist/` 与 `spec-clarify` 命令可用。

### 失败与证据复用

- Bug 修复尽量保留修复前失败、修复后通过的 regression test，不为通过测试改变验收契约。
  失败先依据已有证据区分产品、脚本或环境原因，再定向复查；不因单点失败自动重跑全部。
  共享行为变化或影响面不确定时扩大复查。
- 复用前确认相关实现、测试脚本、共享 fixture、构建产物、环境与覆盖范围仍有效；
  只重跑已失效或尚缺的验证，不重复仍有效的已通过检查。

### 完成与报告

- 完成前须有足够证据覆盖受影响契约、明确验收场景与既有门禁。
  报告实际通过范围、失败原因、复查范围，以及影响交付判断的未验证项，无需另建报告文件。
  不机械扩展平台/设备，不罗列范围外未验证项或通用免责声明。
- 区分事实、推断与未验证项；分批通过不得写成完整命令一次通过，
  局部通过不得暗示完整验收通过。

## 代码规范

- 禁止 `any` / `as any`；外部 runtime 输入（配置文件、审核文档、表单、查询参数、数据库行）在边界 validation。
- 不使用模块级 mutable global 传递跨调用状态；需要跨请求的状态挂在 `createApp` 实例或数据库上。
- 按业务域 / feature 组织代码，避免无边界的 `utils` / `helpers` / `common`。
- 保持依赖方向清晰：`cli / web（entry）→ project、review、clarification、export（logic）→ store、文件读取（data / IO）`。
- 能由 formatter、lint、typecheck 自动保证的规则，以工具结果为准。
- 优先使用 guard clause 提前返回，保持控制流清晰。

## 文档与变更日志

配置、审核文档格式、命令行、库 API、角色权限、部署方式、开发流程或用户可观察行为变化时，同步更新 `README.md`；影响审核文档编写约定时同步更新 `skills/spec-clarify-review/SKILL.md`。

`CHANGELOG.md` 只记录外部可观察的最终变化，不记录内部重构、测试调整或中间态。新变化写在 `## [Unreleased]` 下；发布时把这些条目移到 `## [<版本>] - <日期>` 章节并保留空的 `## [Unreleased]`。已发布版本的章节不再修改。

### AGENTS.md 自身维护

以下内容变化时核对对应章节，只更新已失效的陈述：

| 变更                               | 核对章节                         |
| ---------------------------------- | -------------------------------- |
| 技术栈、分发或部署方式、站点能力   | 项目概述、契约来源、架构与数据流 |
| 记录、编号、digest、权限或安全规则 | Invariants、契约来源             |
| 入口、模块或目录调整               | 架构与数据流、目录与关键文件     |
| 依赖、脚本、环境变量或 CI 变更     | 开发命令、代码约定与常用模式     |
| 测试工具或验证流程变更             | 开发命令、测试与验证             |

## 安全

- 未经明确要求，不执行破坏性、不可逆或发布操作（包括打 tag、创建 GitHub Release、发布到 npm、推送到 `main`），不覆盖用户已有的未提交修改。
- 本仓库公开：不得提交真实项目的需求文档、审核内容、数据库文件、账号密码或其他内部资料；示例与测试数据使用虚构内容。
