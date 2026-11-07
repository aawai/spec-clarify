import { Hono, type Context } from "hono";
import { compress } from "hono/compress";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { html, raw } from "hono/html";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  generatePassword,
  hashPassword,
  hashSessionToken,
  MIN_PASSWORD_LENGTH,
  newSessionToken,
  SESSION_TTL_MS,
  verifyPassword,
} from "../auth.js";
import {
  itemState,
  STATUS_LABELS,
  STATUSES,
  type ItemState,
  type ItemStatus,
} from "../clarification.js";
import { formatTime, renderExport } from "../export.js";
import { loadWorkspace, SourceError, type ProjectConfig, type Workspace } from "../project.js";
import {
  createDocumentRenderer,
  createReviewRenderer,
  docHref,
  type RefEnv,
} from "../render/markdown.js";
import { buildExcerpts, type DocRef, type Excerpt } from "../render/excerpt.js";
import type { ReviewGroup, ReviewItem } from "../review/model.js";
import { ENTRY_LABELS, type Entry, type EntryStore, type ItemActivity } from "../store/entries.js";
import { canClarify, ROLE_LABELS, type User, type UserStore } from "../store/users.js";
import { STYLESHEETS } from "./style.js";
import {
  alert,
  awaitingChip,
  emptyState,
  layout,
  progressBar,
  severityChip,
  staleChip,
  statusChip,
  type Html,
  type NavSection,
} from "./view.js";

export interface AppOptions {
  config: ProjectConfig;
  entries: EntryStore;
  users: UserStore;
  /** Mark the session cookie `Secure`; enable when the site is served over HTTPS. */
  secureCookies?: boolean;
}

interface Session {
  user: User;
  /** Hash of the session token, to end exactly this session. */
  hash: string;
}

/** `session` is set by the sign-in guard; routes registered before it run without one. */
type Env = { Variables: { session?: Session } };

function session(c: Context<Env>): Session {
  const current = c.get("session");
  if (!current) throw new Error(`${c.req.path} is served without a signed-in user`);
  return current;
}

const SESSION_COOKIE = "spec_clarify_session";
const NO_SEVERITY = "none";
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

type ListStatus = ItemStatus | "awaiting";
const LIST_STATUS_LABELS: Record<ListStatus, string> = { ...STATUS_LABELS, awaiting: "待回复" };
const LIST_STATUSES: ListStatus[] = [...STATUSES, "awaiting"];

/** List filters; detail pages carry them along so paging and "back to list" stay in the same view. */
const ListQuery = z.object({
  group: z.string().optional(),
  status: z.enum(LIST_STATUSES as [ListStatus, ...ListStatus[]]).optional(),
  severity: z.string().optional(),
  q: z.string().trim().optional(),
});
type ListFilter = z.infer<typeof ListQuery>;
const FILTER_KEYS = ["group", "status", "severity", "q"] as const;

const Body = z.string().trim().min(1, "内容不能为空").max(5000, "内容不超过 5000 字");
/** `base` (the latest clarification the author saw) is required for clarifications only. */
const EntryForm = z.object({
  body: Body,
  digest: z.string().min(1),
  base: z.optional(z.coerce.number().int().min(0)),
  /** `next`: after a clarification, continue with the next item in the current filter. */
  after: z.literal("next").optional(),
});
const LoginForm = z.object({ username: z.string().trim().min(1), password: z.string().min(1) });
const PasswordForm = z
  .object({
    current: z.string().min(1, "请输入当前密码"),
    password: z.string().min(MIN_PASSWORD_LENGTH, `新密码至少 ${MIN_PASSWORD_LENGTH} 位`).max(200),
    confirm: z.string(),
  })
  .refine((form) => form.password === form.confirm, "两次输入的新密码不一致");

interface FormState {
  kind: "clarification" | "comment";
  error: string;
  body: string;
}

function parseFilter(c: Context): ListFilter {
  const parsed = ListQuery.safeParse(c.req.query());
  return parsed.success ? parsed.data : {};
}

/** Query string for `filter` with `overrides` applied; `undefined` overrides drop a key. */
function filterSearch(filter: ListFilter, overrides: Partial<ListFilter> = {}): string {
  const merged: ListFilter = { ...filter, ...overrides };
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = merged[key];
    if (value) params.set(key, value);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

function hasFilter(filter: ListFilter): boolean {
  return FILTER_KEYS.some((key) => Boolean(filter[key]));
}

function matchesQuery(item: ReviewItem, q: string): boolean {
  const needle = q.toLowerCase();
  return [item.id, item.title, item.body ?? "", ...item.fields.map((field) => field.value)].some(
    (text) => text.toLowerCase().includes(needle),
  );
}

function matchesFilter(item: ReviewItem, state: ItemState, filter: ListFilter): boolean {
  const statusMatches =
    !filter.status ||
    (filter.status === "awaiting" ? state.awaitingReply : state.status === filter.status);
  const severityMatches =
    !filter.severity ||
    (filter.severity === NO_SEVERITY ? !item.severity : item.severity === filter.severity);
  return (
    (!filter.group || item.group.key === filter.group) &&
    statusMatches &&
    severityMatches &&
    (!filter.q || matchesQuery(item, filter.q))
  );
}

/**
 * The item after `index` in review order that matches `filter`. Found by review position because
 * the current item may itself have just left the filter (e.g. clarified while viewing 未澄清).
 */
function nextInFilter(
  items: ReviewItem[],
  index: number,
  filter: ListFilter,
  activity: Map<string, ItemActivity>,
): ReviewItem | undefined {
  return items
    .slice(index + 1)
    .find((candidate) =>
      matchesFilter(candidate, itemState(candidate, activity.get(candidate.id)), filter),
    );
}

/** Groups in review order, gathered under their navigation section. */
function groupSections(groups: ReviewGroup[]): { title: string; groups: ReviewGroup[] }[] {
  const sections: { title: string; groups: ReviewGroup[] }[] = [];
  for (const group of groups) {
    const section = sections.find((candidate) => candidate.title === group.section);
    if (section) section.groups.push(group);
    else sections.push({ title: group.section, groups: [group] });
  }
  return sections;
}

/** Only same-site paths are accepted as post-login targets. */
function safeNext(next: string | undefined): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/";
}

function text(form: Record<string, unknown>, key: string): string {
  const value = form[key];
  return typeof value === "string" ? value : "";
}

/** Referenced source lines, one column per document so conflicting passages sit side by side. */
function excerptsView(excerpts: Excerpt[]): Html {
  return html`<section class="card card--default card--padded" id="sources">
    <h2 class="section-title">原文对照</h2>
    <div class="excerpts">
      ${excerpts.map(
        (excerpt) =>
          html`<div class="excerpt">
            <a class="excerpt__file mono" href="${docHref(excerpt.path)}">${excerpt.path}</a>
            ${excerpt.windows.map((window, index) => {
              const omittedFrom = (excerpt.windows[index - 1]?.end ?? 0) + 1;
              return html`${
                  index
                    ? html`<a
                        class="excerpt__gap"
                        href="${docHref(excerpt.path, omittedFrom, window.start - 1)}"
                        >省略第 ${omittedFrom}–${window.start - 1} 行，在文档中查看</a
                      >`
                    : ""
                }
                <div class="excerpt__lines">
                  ${window.lines.map(
                    (line) =>
                      html`<div class="excerpt__line${line.hit ? " is-hit" : ""}">
                        <span class="excerpt__number">${line.number}</span
                        ><span class="excerpt__text">${line.text}</span>
                      </div>`,
                  )}
                </div>`;
            })}
          </div>`,
      )}
    </div>
  </section>`;
}

export function createApp(options: AppOptions) {
  const { config, entries, users } = options;
  const reviewMd = createReviewRenderer();
  const documentMd = createDocumentRenderer({ trustHtml: config.trustDocumentHtml });
  const loginFailures = new Map<string, { count: number; lockedUntil: number }>();
  // Unknown usernames are checked against this hash so they take as long as wrong passwords.
  const dummyHash = hashPassword(generatePassword());
  const app = new Hono<Env>();

  const page = (c: Context<Env>, pageTitle: string, active: NavSection | undefined, body: Html) =>
    layout({ siteTitle: config.title, pageTitle, active, user: c.get("session")?.user }, body);
  const message = (
    c: Context<Env>,
    status: 403 | 404 | 503,
    title: string,
    text: string,
    back?: { href: string; label: string },
  ) =>
    c.html(
      page(
        c,
        title,
        undefined,
        html`<div class="page-head"><h1>${title}</h1></div>
          ${emptyState(text, back)}`,
      ),
      status,
    );

  // The item list for a few hundred items is several hundred KB of HTML; compressed it is a
  // small fraction of that, which matters on slow office networks.
  app.use(compress());
  app.use(async (c, next) => {
    await next();
    const images = config.allowExternalImages ? "* data:" : "'self' data:";
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; img-src ${images}; style-src 'self' 'unsafe-inline'; script-src 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.use(csrf());

  app.onError((error, c) => {
    // Middleware rejections (CSRF) carry their own response; they are not server faults.
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof SourceError) {
      // Nothing is shown or recorded until the sources parse again: records must never attach to
      // an item text that the site can no longer read.
      return message(
        c,
        503,
        "审核文档无法读取",
        `${error.message}。修复后刷新页面即可恢复；在此之前暂停查看与提交。`,
      );
    }
    console.error(error);
    return c.text("服务器内部错误", 500);
  });

  for (const sheet of STYLESHEETS) {
    app.get(sheet.href, (c) =>
      c.body(sheet.css, 200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      }),
    );
  }

  const loginPage = (c: Context<Env>, next: string, error?: string, username = "") =>
    c.html(
      page(
        c,
        "登录",
        undefined,
        html`<form
          method="post"
          action="/login"
          class="card card--default card--padded form narrow"
        >
          <h1>登录 ${config.title}</h1>
          ${error ? alert("danger", error) : ""}
          <input type="hidden" name="next" value="${next}" />
          <label class="field">
            <span class="field__label">用户名</span>
            <input
              class="input input--full-width"
              name="username"
              value="${username}"
              required
              autocomplete="username"
            />
          </label>
          <label class="field">
            <span class="field__label">密码</span>
            <input
              class="input input--full-width"
              type="password"
              name="password"
              required
              autocomplete="current-password"
            />
          </label>
          <button class="button button--primary button--full-width" type="submit">登录</button>
          <p class="field__hint">账号由管理员创建；忘记密码请联系管理员重置。</p>
        </form>`,
      ),
      error ? 401 : 200,
    );

  app.get("/login", (c) => loginPage(c, safeNext(c.req.query("next"))));

  app.post("/login", async (c) => {
    const submitted = await c.req.parseBody();
    const next = safeNext(text(submitted, "next"));
    const parsed = LoginForm.safeParse(submitted);
    if (!parsed.success) return loginPage(c, next, "请输入用户名和密码");
    const { username, password } = parsed.data;
    const key = username.toLowerCase();
    const now = Date.now();
    const failures = loginFailures.get(key);
    if (failures && failures.lockedUntil > now) {
      return loginPage(c, next, "登录失败次数过多，请 15 分钟后再试", username);
    }
    const user = await users.byUsername(username);
    const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !valid || user.disabled) {
      const count = (failures?.count ?? 0) + 1;
      loginFailures.set(key, {
        count: count >= MAX_LOGIN_FAILURES ? 0 : count,
        lockedUntil: count >= MAX_LOGIN_FAILURES ? now + LOGIN_LOCK_MS : 0,
      });
      return loginPage(c, next, "用户名或密码错误，或账号已停用", username);
    }
    loginFailures.delete(key);
    const token = newSessionToken();
    await users.createSession(user.id, hashSessionToken(token), new Date(now + SESSION_TTL_MS));
    setCookie(c, SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: options.secureCookies ?? false,
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect(next, 303);
  });

  // Every route below requires a signed-in, enabled user.
  app.use(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const sessionHash = token ? hashSessionToken(token) : undefined;
    const user = sessionHash ? await users.sessionUser(sessionHash) : undefined;
    if (!user || !sessionHash) {
      const target = c.req.method === "GET" ? c.req.path + new URL(c.req.url).search : "/";
      return c.redirect(`/login?${new URLSearchParams({ next: target })}`, 303);
    }
    c.set("session", { user, hash: sessionHash });
    await next();
  });

  app.post("/logout", async (c) => {
    await users.deleteSession(session(c).hash);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login", 303);
  });

  const accountPage = (c: Context<Env>, notice?: Html, httpStatus: 200 | 422 = 200) => {
    const { user } = session(c);
    return c.html(
      page(
        c,
        "账户",
        "account",
        html`<div class="card card--default card--padded form narrow">
          <h1>账户</h1>
          <dl class="profile">
            <dt>用户名</dt>
            <dd class="mono">${user.username}</dd>
            <dt>姓名</dt>
            <dd>${user.displayName}</dd>
            <dt>角色</dt>
            <dd>
              ${ROLE_LABELS[user.role]}${canClarify(user.role) ? "（可提交澄清）" : "（可评论、追问）"}
            </dd>
          </dl>
          <form method="post" action="/account/password" class="form">
            <h2 class="section-title">修改密码</h2>
            ${notice ?? ""}
            <label class="field">
              <span class="field__label">当前密码</span>
              <input
                class="input input--full-width"
                type="password"
                name="current"
                required
                autocomplete="current-password"
              />
            </label>
            <label class="field">
              <span class="field__label">新密码</span>
              <input
                class="input input--full-width"
                type="password"
                name="password"
                required
                minlength="${MIN_PASSWORD_LENGTH}"
                autocomplete="new-password"
              />
              <span class="field__hint"
                >至少 ${MIN_PASSWORD_LENGTH} 位。修改后，其他设备上的登录会失效。</span
              >
            </label>
            <label class="field">
              <span class="field__label">确认新密码</span>
              <input
                class="input input--full-width"
                type="password"
                name="confirm"
                required
                autocomplete="new-password"
              />
            </label>
            <button class="button button--primary" type="submit">修改密码</button>
          </form>
        </div>`,
      ),
      httpStatus,
    );
  };

  app.get("/account", (c) =>
    accountPage(c, c.req.query("changed") ? alert("success", "密码已修改") : undefined),
  );

  app.post("/account/password", async (c) => {
    const parsed = PasswordForm.safeParse(await c.req.parseBody());
    if (!parsed.success) {
      return accountPage(
        c,
        alert("danger", parsed.error.issues.map((issue) => issue.message).join("；")),
        422,
      );
    }
    const user = await users.byId(session(c).user.id);
    if (!user || !(await verifyPassword(parsed.data.current, user.passwordHash))) {
      return accountPage(c, alert("danger", "当前密码不正确"), 422);
    }
    await users.setPassword(user.id, await hashPassword(parsed.data.password), session(c).hash);
    return c.redirect("/account?changed=1", 303);
  });

  const inline = (value: string, env: RefEnv) => raw(reviewMd.renderInline(value, env));
  const plain = (value: string) => inline(value, { resolve: () => undefined });
  const refEnv = (workspace: Workspace, item: ReviewItem): RefEnv => ({
    defaultDocument: item.defaultDocument ?? item.group.defaultDocument,
    resolve: workspace.resolve,
  });
  const severity = (value: string) => severityChip(value, config.severities);

  app.get("/", async (c) => {
    const { review, reviews } = await loadWorkspace(config);
    const activity = await entries.activity();
    const filter = parseFilter(c);
    const states = new Map(
      review.items.map((item) => [item.id, itemState(item, activity.get(item.id))]),
    );
    const state = (item: ReviewItem) =>
      states.get(item.id) ?? { status: "open", awaitingReply: false };

    const items = review.items.filter((item) => matchesFilter(item, state(item), filter));
    // Status tab counts honour every filter except the status itself.
    const statusScope = review.items.filter((item) =>
      matchesFilter(item, state(item), { ...filter, status: undefined }),
    );
    const clarified = (list: ReviewItem[]) =>
      list.filter((item) => state(item).status === "clarified").length;

    const groupLink = (group: ReviewGroup | undefined) => {
      const groupItems = group ? review.items.filter((item) => item.group === group) : review.items;
      const done = clarified(groupItems);
      const current = group?.key === filter.group;
      return html`<a
        class="group-nav__link"
        href="/${filterSearch(filter, { group: group?.key })}"
        ${current ? html`aria-current="true"` : ""}
      >
        <span>${group ? group.label : "全部条目"}</span>
        <span class="group-nav__count">${done}/${groupItems.length}</span>
        ${progressBar(done, groupItems.length)}
      </a>`;
    };

    const statusTab = (value: ListStatus | undefined, label: string) => {
      const count = value
        ? statusScope.filter((item) => matchesFilter(item, state(item), { status: value })).length
        : statusScope.length;
      return html`<a
        class="tabs__tab"
        href="/${filterSearch(filter, { status: value })}"
        ${value === filter.status ? html`aria-current="true"` : ""}
      >
        ${label}<span class="tab-count">${count}</span>
      </a>`;
    };

    const option = (value: string, label: string, selected: string | undefined) =>
      html`<option value="${value}" ${value === (selected ?? "") ? "selected" : ""}>
        ${label}
      </option>`;
    const presentSeverities = new Set(review.items.map((item) => item.severity));
    const severityOptions = [
      ...config.severities.filter((value) => presentSeverities.has(value)),
      ...[...presentSeverities]
        .filter(
          (value): value is string => Boolean(value) && !config.severities.includes(value ?? ""),
        )
        .sort(),
    ];
    const severitySelect = severityOptions.length
      ? html`<select class="input" name="severity" aria-label="严重度">
          ${option("", "全部严重度", filter.severity)}
          ${severityOptions.map((value) => option(value, value, filter.severity))}
          ${presentSeverities.has(undefined) ? option(NO_SEVERITY, "无严重度", filter.severity) : ""}
        </select>`
      : "";

    const itemSearch = filterSearch(filter);
    const table = items.length
      ? html`<div class="table-root table-root--secondary items">
          <div class="table__scroll-container">
            <table class="table__content">
              <thead class="table__header">
                <tr>
                  <th class="table__column col-id">编号</th>
                  <th class="table__column">条目</th>
                  <th class="table__column col-chip">严重度</th>
                  <th class="table__column col-status">状态</th>
                  <th class="table__column col-num">记录</th>
                  <th class="table__column col-time">最近更新</th>
                </tr>
              </thead>
              <tbody class="table__body">
                ${items.map((item) => {
                  const itemActivity = activity.get(item.id);
                  const { status, awaitingReply } = state(item);
                  return html`<tr class="table__row">
                    <td class="table__cell col-id mono">${item.id}</td>
                    <td class="table__cell">
                      <a class="item-link" href="/items/${encodeURIComponent(item.id)}${itemSearch}"
                        >${plain(item.title)}</a
                      >
                      ${filter.group ? "" : html`<span class="item-group">${item.group.title}</span>`}
                    </td>
                    <td class="table__cell col-chip">
                      ${item.severity ? severity(item.severity) : ""}
                    </td>
                    <td class="table__cell col-status">
                      <div class="status-cell">
                        ${statusChip(status)} ${awaitingReply ? awaitingChip() : ""}
                      </div>
                    </td>
                    <td class="table__cell col-num">${itemActivity?.entryCount || ""}</td>
                    <td class="table__cell col-time muted">
                      ${itemActivity ? formatTime(itemActivity.lastActivity) : ""}
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>
        </div>`
      : emptyState("没有符合条件的条目。", { href: "/", label: "清除筛选" });

    return c.html(
      page(
        c,
        "澄清条目",
        "items",
        html`<div class="page-head">
            <div>
              <h1>澄清条目</h1>
              <p class="muted">
                条目来自
                ${reviews.map(
                  (doc, index) =>
                    html`${index ? "、" : ""}<a href="${docHref(doc.path)}">${doc.path}</a>`,
                )}。点击条目查看原文位置、提交澄清或参与讨论。
              </p>
            </div>
            <div class="overall">
              ${progressBar(clarified(review.items), review.items.length, "已澄清")}
            </div>
          </div>
          <div class="list-layout">
            <nav class="card card--default group-nav" aria-label="分组">
              ${groupLink(undefined)}
              ${groupSections(review.groups).map(
                (section) =>
                  html`<div class="group-nav__section">${section.title}</div>
                    ${section.groups.map(groupLink)}`,
              )}
            </nav>
            <section>
              <nav class="status-tabs" aria-label="状态">
                ${statusTab(undefined, "全部")}
                ${LIST_STATUSES.map((value) => statusTab(value, LIST_STATUS_LABELS[value]))}
              </nav>
              <form class="filter-bar" method="get" action="/" role="search">
                ${filter.group ? html`<input type="hidden" name="group" value="${filter.group}" />` : ""}
                ${filter.status ? html`<input type="hidden" name="status" value="${filter.status}" />` : ""}
                ${severitySelect}
                <input
                  class="input"
                  type="search"
                  name="q"
                  value="${filter.q ?? ""}"
                  placeholder="搜索编号或关键词"
                  aria-label="关键词"
                />
                <button class="button button--primary" type="submit">搜索</button>
                ${hasFilter(filter) ? html`<a class="button button--ghost" href="/">清除筛选</a>` : ""}
                <span class="result-count">显示 ${items.length} / ${review.items.length} 条</span>
              </form>
              ${table}
            </section>
          </div>`,
      ),
    );
  });

  /** `httpStatus` is 422 for invalid input and 409 when newer state rejected the submission. */
  const renderItem = async (
    c: Context<Env>,
    id: string,
    form?: FormState,
    httpStatus: 200 | 409 | 422 = 200,
  ) => {
    const workspace = await loadWorkspace(config);
    const { items } = workspace.review;
    const index = items.findIndex((candidate) => candidate.id === id);
    const item = items[index];
    if (!item) {
      return message(c, 404, "未找到条目", `审核文档中没有编号为 ${id} 的条目。`, {
        href: "/",
        label: "返回列表",
      });
    }
    const { user } = session(c);
    const filter = parseFilter(c);
    const search = filterSearch(filter);
    const [history, activity] = await Promise.all([
      entries.entriesFor(item.id),
      entries.activity(),
    ]);
    const clarification = history.filter((entry) => entry.kind === "clarification").at(-1);
    const { status, awaitingReply } = itemState(item, activity.get(item.id));
    // Review text is rendered before the page so the references it links can be excerpted.
    const refs: DocRef[] = [];
    const env: RefEnv = { ...refEnv(workspace, item), refs };
    const fields = item.fields.map((field) => ({
      label: field.label,
      value: inline(field.value, env),
    }));
    const reviewBody = item.body ? raw(reviewMd.render(item.body, env)) : undefined;
    const excerpts = buildExcerpts(refs, (path) => workspace.resolve(path)?.source);
    const backlinks = items
      .filter((other) => other.related.includes(item.id))
      .map((other) => other.id);

    // Paging walks the filtered list in review order; the current item may have left the filter
    // (e.g. just clarified while viewing "未澄清"), so neighbours are found by review position.
    const inFilter = (candidate: ReviewItem) =>
      matchesFilter(candidate, itemState(candidate, activity.get(candidate.id)), filter);
    const matching = items.filter(inFilter);
    const previous = items.slice(0, index).filter(inFilter).at(-1);
    const next = nextInFilter(items, index, filter, activity);
    const position = matching.indexOf(item);

    const itemHref = (target: string) => `/items/${encodeURIComponent(target)}${search}`;
    const pagerButton = (target: ReviewItem | undefined, label: string) =>
      target
        ? html`<a class="button button--tertiary button--sm" href="${itemHref(target.id)}"
            >${label}</a
          >`
        : html`<span class="button button--tertiary button--sm" aria-disabled="true"
            >${label}</span
          >`;
    const idLinks = (ids: string[]) =>
      ids.map(
        (relatedId) =>
          html`<a class="chip chip--accent chip--soft chip--id" href="${itemHref(relatedId)}"
            >${relatedId}</a
          >`,
      );

    const entryView = (entry: Entry) =>
      html`<li id="entry-${entry.id}" class="entry entry--${entry.kind}">
        <span class="avatar avatar--sm avatar--soft" aria-hidden="true">
          <span
            class="avatar__fallback ${entry.kind === "clarification" ? "avatar__fallback--accent" : "avatar__fallback--default"}"
            >${Array.from(entry.author.displayName)[0] ?? ""}</span
          >
        </span>
        <div>
          <div class="entry__meta">
            <span class="entry__author">${entry.author.displayName}</span>
            <span class="muted">${ENTRY_LABELS[entry.kind]}</span>
            <span class="muted">${formatTime(entry.createdAt)}</span>
            ${entry.itemDigest !== item.digest ? staleChip("基于旧版条目") : ""}
          </div>
          <div class="entry__body">${entry.body}</div>
        </div>
      </li>`;

    const errorFor = (kind: FormState["kind"]) =>
      form?.kind === kind ? alert("danger", "提交未成功", form.error) : "";
    const valueFor = (kind: FormState["kind"]) => (form?.kind === kind ? form.body : "");
    const action = (kind: string) => `/items/${encodeURIComponent(item.id)}/${kind}${search}`;

    const clarifyForm = canClarify(user.role)
      ? html`<form
          method="post"
          action="${action("clarifications")}"
          class="card card--default card--padded form"
          id="clarify"
        >
          <h2 class="section-title">${clarification ? "更新澄清" : "提交澄清"}</h2>
          ${errorFor("clarification")}
          <input type="hidden" name="digest" value="${item.digest}" />
          <input type="hidden" name="base" value="${clarification?.id ?? 0}" />
          <label class="field">
            <span class="field__label">澄清内容</span>
            <textarea
              class="textarea textarea--full-width"
              name="body"
              rows="6"
              required
              maxlength="5000"
              placeholder="写明结论、依据，以及需要回写到哪份文档"
            >
${valueFor("clarification")}</textarea>
            <span class="field__hint"
              >以 ${user.displayName} 的名义提交。记录只追加，更正请再提交一次。</span
            >
          </label>
          ${
            next
              ? html`<button
                  class="button button--primary button--full-width"
                  type="submit"
                  name="after"
                  value="next"
                >
                  ${clarification ? "更新并下一条" : "提交并下一条"}
                </button>`
              : ""
          }
          <button
            class="button ${next ? "button--secondary" : "button--primary"} button--full-width"
            type="submit"
          >
            ${clarification ? "更新澄清" : "提交澄清"}
          </button>
        </form>`
      : html`<section class="card card--default card--padded">
          <p class="readonly-note">澄清由产品方提交。对条目或澄清有疑问，请在左侧追问。</p>
        </section>`;

    const body = html`<div class="detail-top">
        <nav class="breadcrumbs" aria-label="位置">
          <span class="breadcrumbs__item"
            ><a class="breadcrumbs__link" href="/${search}"
              >${hasFilter(filter) ? "澄清条目（筛选结果）" : "澄清条目"}</a
            ></span
          >
          <span class="breadcrumbs__separator" aria-hidden="true">/</span>
          <span class="breadcrumbs__item"
            ><a class="breadcrumbs__link" href="/${filterSearch({ group: item.group.key })}"
              >${item.group.title}</a
            ></span
          >
        </nav>
        <nav class="pager" aria-label="翻页">
          ${pagerButton(previous, "‹ 上一条")}
          <span class="pager__position">
            ${position >= 0 ? `${position + 1} / ${matching.length}` : `不在筛选结果中（共 ${matching.length} 条）`}
          </span>
          ${pagerButton(next, "下一条 ›")}
        </nav>
      </div>
      <header class="item-head">
        <div class="item-head__meta">
          <span class="chip chip--default chip--id">${item.id}</span>
          ${statusChip(status)} ${awaitingReply ? awaitingChip() : ""}
          ${item.severity ? severity(item.severity) : ""}
          <span class="muted">${item.group.label}</span>
          <span class="muted">·</span>
          <a href="${docHref(item.group.source, item.line, item.endLine)}"
            >${item.group.source} 第 ${item.line} 行</a
          >
        </div>
        <h1>${plain(item.title)}</h1>
      </header>
      ${status === "stale" ? alert("danger", "本条目在最近一次澄清后已修改", "请核对审核文档的最新内容，确认澄清是否仍然成立并重新提交。") : ""}
      <div class="detail-layout">
        <div class="detail-main">
          <section class="card card--default card--padded">
            <h2 class="section-title">审核意见</h2>
            ${
              fields.length
                ? html`<dl class="fields">
                    ${fields.map(
                      (field) =>
                        html`<dt>${field.label}</dt>
                          <dd>${field.value}</dd>`,
                    )}
                  </dl>`
                : ""
            }
            ${reviewBody ? html`<div class="prose">${reviewBody}</div>` : ""}
            ${item.related.length ? html`<div class="links-row"><span class="muted">相关条目</span>${idLinks(item.related)}</div>` : ""}
            ${backlinks.length ? html`<div class="links-row"><span class="muted">被以下条目引用</span>${idLinks(backlinks)}</div>` : ""}
          </section>
          ${excerpts.length ? excerptsView(excerpts) : ""}
          <section class="card card--default card--padded">
            <h2 class="section-title">处理记录（${history.length}）</h2>
            ${
              history.length
                ? html`<ol class="timeline">
                    ${history.map(entryView)}
                  </ol>`
                : html`<p class="muted">暂无记录。</p>`
            }
            <form method="post" action="${action("comments")}" class="form composer" id="comment">
              <h3 class="section-title">评论 / 追问</h3>
              ${errorFor("comment")}
              <input type="hidden" name="digest" value="${item.digest}" />
              <textarea
                class="textarea textarea--full-width"
                name="body"
                rows="3"
                required
                maxlength="5000"
                aria-label="内容"
                placeholder="不改变澄清状态；产品方回复前，条目显示“待回复”"
              >
${valueFor("comment")}</textarea>
              <div class="form-actions">
                <span class="field__hint">以 ${user.displayName} 的名义发表</span>
                <button class="button button--secondary" type="submit">发表</button>
              </div>
            </form>
          </section>
        </div>
        <aside class="detail-side">
          ${
            clarification
              ? html`<section
                  class="card card--default card--padded conclusion ${status === "stale" ? "is-stale" : ""}"
                >
                  <h2 class="section-title">当前澄清 ${statusChip(status)}</h2>
                  <div class="conclusion__body">${clarification.body}</div>
                  <div class="conclusion__meta">
                    ${clarification.author.displayName} · ${formatTime(clarification.createdAt)}
                  </div>
                </section>`
              : ""
          }
          ${clarifyForm}
        </aside>
      </div>`;
    return c.html(page(c, item.id, "items", body), httpStatus);
  };

  app.get("/items/:id", (c) => renderItem(c, c.req.param("id")));

  const submit = (kind: FormState["kind"]) => async (c: Context<Env>) => {
    const id = c.req.param("id") ?? "";
    const { user } = session(c);
    if (kind === "clarification" && !canClarify(user.role)) {
      return message(c, 403, "无权提交澄清", "澄清由产品方提交；你可以在条目页发表评论或追问。", {
        href: `/items/${encodeURIComponent(id)}`,
        label: "返回条目",
      });
    }
    const submitted = await c.req.parseBody();
    const fail = (error: string, status: 409 | 422) =>
      renderItem(c, id, { kind, error, body: text(submitted, "body") }, status);

    const parsed = EntryForm.safeParse(submitted);
    if (!parsed.success)
      return fail(parsed.error.issues.map((issue) => issue.message).join("；"), 422);
    const form = parsed.data;
    if (kind === "clarification" && form.base === undefined) return fail("缺少基准澄清编号", 422);

    const { items } = (await loadWorkspace(config)).review;
    const index = items.findIndex((candidate) => candidate.id === id);
    const item = items[index];
    if (!item) return renderItem(c, id);
    if (kind === "clarification" && form.digest !== item.digest) {
      return fail("审核文档中的本条目已更新，请阅读最新内容后再提交澄清。你的内容已保留。", 409);
    }

    const result = await entries.add({
      itemId: item.id,
      kind,
      userId: user.id,
      body: form.body,
      itemDigest: form.digest,
      baseClarificationId: kind === "clarification" ? form.base : undefined,
    });
    if (!result.ok) {
      const { latest } = result;
      return fail(
        `${latest.author.displayName} 已于 ${formatTime(latest.createdAt)} 提交了新的澄清，请阅读后再提交。你的内容已保留。`,
        409,
      );
    }
    const filter = parseFilter(c);
    if (kind === "clarification" && form.after === "next") {
      const next = nextInFilter(items, index, filter, await entries.activity());
      if (next)
        return c.redirect(`/items/${encodeURIComponent(next.id)}${filterSearch(filter)}`, 303);
    }
    return c.redirect(
      `/items/${encodeURIComponent(item.id)}${filterSearch(filter)}#entry-${result.entry.id}`,
      303,
    );
  };
  app.post("/items/:id/clarifications", submit("clarification"));
  app.post("/items/:id/comments", submit("comment"));

  app.get("/docs", async (c) => {
    const { documents } = await loadWorkspace(config);
    return c.html(
      page(
        c,
        "文档",
        "docs",
        html`<div class="page-head">
            <div>
              <h1>文档</h1>
              <p class="muted">在站内阅读源文档与审核文档，左侧数字为源文件行号。</p>
            </div>
          </div>
          <div class="doc-grid">
            ${documents.map(
              (doc) =>
                html`<a class="card card--default doc-tile" href="${docHref(doc.path)}">
                  <span class="card__title">${doc.title}</span>
                  <span class="card__description mono">${doc.path}</span>
                </a>`,
            )}
          </div>`,
      ),
    );
  });

  app.get("/docs/view", async (c) => {
    const { documents } = await loadWorkspace(config);
    const doc = documents.find((candidate) => candidate.path === c.req.query("path"));
    if (!doc)
      return message(c, 404, "未找到文档", "没有这份文档。", {
        href: "/docs",
        label: "返回文档列表",
      });
    const start = Number(c.req.query("line"));
    const end = Number(c.req.query("end") ?? start);
    const highlight =
      Number.isInteger(start) && start > 0
        ? { start, end: Number.isInteger(end) && end >= start ? end : start }
        : undefined;
    return c.html(
      page(
        c,
        doc.title,
        "docs",
        html`<div class="docs-layout">
          <nav class="card card--default group-nav" aria-label="文档">
            ${documents.map(
              (other) =>
                html`<a
                  class="group-nav__link"
                  href="${docHref(other.path)}"
                  ${other.path === doc.path ? html`aria-current="true"` : ""}
                  ><span>${other.title}</span></a
                >`,
            )}
          </nav>
          <div class="card card--default doc-card">
            <nav class="breadcrumbs" aria-label="位置">
              <span class="breadcrumbs__item"
                ><a class="breadcrumbs__link" href="/docs">文档</a></span
              >
              <span class="breadcrumbs__separator" aria-hidden="true">/</span>
              <span class="breadcrumbs__item mono muted">${doc.path}</span>
            </nav>
            ${
              highlight
                ? alert(
                    "accent",
                    `已定位到第 ${highlight.start}${highlight.end > highlight.start ? `–${highlight.end}` : ""} 行`,
                    html`高亮部分即引用位置，<a href="#hl">跳转到高亮处</a
                      >。左侧数字为源文件行号。`,
                  )
                : html`<p class="muted">
                    左侧数字为源文件行号，与审核文档中的 <code>文件:行号</code> 对应。
                  </p>`
            }
            <article class="prose doc">
              ${raw(documentMd.render(doc.source, { highlight }))}
            </article>
          </div>
        </div>`,
      ),
    );
  });

  app.get("/export.md", async (c) => {
    const { review, reviews } = await loadWorkspace(config);
    const [all, activity] = await Promise.all([entries.all(), entries.activity()]);
    const markdown = renderExport({
      title: config.title,
      sources: reviews.map((doc) => doc.path),
      review,
      entries: all,
      activity,
      generatedAt: new Date(),
    });
    return c.body(markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="clarifications.md"`,
    });
  });

  return app;
}
