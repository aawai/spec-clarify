# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 主要用户：产品方（`product` 角色）在桌面浏览器上**逐条批量澄清**审核意见。一个项目的条目量可达数百条（实测项目 539 条），常常连续处理：读审核意见 → 看原文 → 写结论 → 下一条。效率是第一诉求。
- 次要用户：工程方（`engineer`）阅读澄清并评论追问；管理员（`admin`）管理账号、导出记录。

## Product Purpose

把一个项目的一份或多份 Markdown 审核文档拆成带显式编号的条目，让产品方逐条给出澄清结论，工程方评论追问，全部记录只追加、可导出为 Markdown。成功标准：每个条目都有基于当前内容的澄清，且结论可以追溯到源文档的具体行。

## Positioning

条目与源文档行号直接绑定（`文件:行号` 引用、按内容计算的 digest 以及“需复核”状态），记录只追加并且有并发保护；这是通用工单或评论工具做不到的。

## Operating Context

- 自托管：单个 Node.js 进程加 SQLite，在局域网内访问（如 `http://192.168.x.x`），页面由服务端渲染，**不运行客户端脚本**（CSP `script-src 'none'`）。
- 审核条目常引用两份或多份源文档中互相矛盾的行（如 `account.md:245 vs role.md:15、209–210`）；判断时需要对照这些原文。
- 界面只有简体中文。

## Capabilities and Constraints

- 角色：`product` / `admin` 可提交澄清；`engineer` 只能评论。
- 提交澄清必须带上 digest 和 base，冲突时返回 409 并保留草稿；源文件不可用时返回 503。
- 样式基于 `@heroui/styles` 预编译 CSS，再叠加站点 CSS（`src/web/style.ts`）；不引入 React、Tailwind 构建或客户端脚本。
- 已确认需求（2026-11）：条目页内嵌被引用的原文片段，多文件并排对照，不再要求跳页。

## Evidence on Hand

- 示例项目 `examples/basic/`（虚构内容）。本仓库公开，不得放入真实项目内容。

## Product Principles

1. 澄清所需的信息都在一屏内：审核意见、被引原文、结论表单同时可见。
2. 连续处理优先：提交后、翻页时都不丢失上下文与筛选。
3. 记录可信：状态、过期（需复核）、冲突要明确可见，不弱化。
4. 无脚本也完整：所有交互都基于链接、表单和原生 HTML（`<details>`、`:target`）。
