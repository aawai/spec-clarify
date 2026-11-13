import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { STATUS_LABELS, type ItemStatus } from "../clarification.js";
import { ROLE_LABELS, type User } from "../store/users.js";
import { STYLESHEETS } from "./style.js";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export type NavSection = "items" | "docs" | "account";

const STATUS_COLORS: Record<ItemStatus, string> = {
  open: "chip--warning",
  clarified: "chip--success",
  stale: "chip--danger",
};

/** Colours by rank on the configured scale: the most severe levels stand out most. */
const SEVERITY_TONES = [
  "chip--danger chip--primary",
  "chip--danger chip--soft",
  "chip--warning chip--soft",
];

export function statusChip(status: ItemStatus): Html {
  return html`<span class="chip chip--soft ${STATUS_COLORS[status]}"
    >${STATUS_LABELS[status]}</span
  >`;
}

export function awaitingChip(): Html {
  return html`<span class="chip chip--soft chip--accent">待回复</span>`;
}

export function severityChip(severity: string, scale: readonly string[]): Html {
  const rank = scale.indexOf(severity);
  const tone = (rank >= 0 ? SEVERITY_TONES[rank] : undefined) ?? "chip--default chip--soft";
  return html`<span class="chip ${tone}">${severity}</span>`;
}

export function staleChip(label: string): Html {
  return html`<span class="chip chip--danger chip--soft">${label}</span>`;
}

export function progressBar(done: number, total: number, label?: string, awaitingDone = 0): Html {
  const totalPercent = total ? Math.round((done / total) * 100) : 0;
  const awaitingCount = Math.max(0, Math.min(done, awaitingDone));
  const readyDone = done - awaitingCount;
  const readyPercent = total ? Math.round((readyDone / total) * 100) : 0;
  const outputText =
    awaitingCount > 0
      ? `${done} / ${total}（${totalPercent}%，含 ${awaitingCount} 条待回复）`
      : `${done} / ${total}（${totalPercent}%）`;
  return html`<div
    class="progress-bar ${label ? "progress-bar--md" : "progress-bar--sm"} progress-bar--success"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="${total}"
    aria-valuenow="${done}"
    aria-label="${label ?? "澄清进度"}"
  >
    ${
      label
        ? html`<span data-slot="label">${label}</span>
            <span class="progress-bar__output">${outputText}</span>`
        : ""
    }
    <div class="progress-bar__track">
      ${
        awaitingCount > 0
          ? html`<div class="progress-bar__awaiting" style="width: ${totalPercent}%"></div>`
          : ""
      }
      <div class="progress-bar__fill" style="width: ${readyPercent}%"></div>
    </div>
  </div>`;
}

export function alert(
  tone: "danger" | "accent" | "success",
  title: string,
  description?: Html | string,
): Html {
  return html`<div class="alert alert--${tone}" role="${tone === "danger" ? "alert" : "status"}">
    <div class="alert__content">
      <p class="alert__title">${title}</p>
      ${description ? html`<div class="alert__description">${description}</div>` : ""}
    </div>
  </div>`;
}

export function emptyState(message: string, action?: { href: string; label: string }): Html {
  return html`<div class="card card--default empty-state">
    <p>${message}</p>
    ${action ? html`<p><a class="button button--secondary" href="${action.href}">${action.label}</a></p>` : ""}
  </div>`;
}

export interface LayoutOptions {
  siteTitle: string;
  pageTitle: string;
  active?: NavSection;
  /** Signed-in user; the navigation is only shown to signed-in users. */
  user?: User;
}

export function layout(options: LayoutOptions, body: Html): Html {
  const { siteTitle, pageTitle, active, user } = options;
  const navLink = (section: NavSection, href: string, label: string) =>
    html`<a
      class="app-nav__link"
      href="${href}"
      ${active === section ? html`aria-current="page"` : ""}
      >${label}</a
    >`;
  return html`<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>${pageTitle} · ${siteTitle}</title>
        ${STYLESHEETS.map((sheet) => html`<link rel="stylesheet" href="${sheet.href}" />`)}
      </head>
      <body>
        <header class="app-header">
          <div class="app-header__inner">
            <a class="brand" href="/"
              ><span class="brand__mark" aria-hidden="true">SC</span><span>${siteTitle}</span></a
            >
            ${
              user
                ? html`<nav class="app-nav" aria-label="主导航">
                      ${navLink("items", "/", "澄清条目")} ${navLink("docs", "/docs", "项目文档")}
                    </nav>
                    <div class="user-menu">
                      <a
                        class="button button--secondary button--sm"
                        href="/export.md"
                        title="导出全项目所有条目的当前状态与完整历史（Markdown 格式，不受筛选条件影响）"
                        >导出记录</a
                      >
                      <a
                        class="button button--ghost button--sm user-menu__account"
                        href="/account"
                        ${active === "account" ? html`aria-current="page"` : ""}
                        >${user.displayName}<span class="user-menu__role"
                          >（${ROLE_LABELS[user.role]}）</span
                        ></a
                      >
                      <form method="post" action="/logout">
                        <button class="button button--ghost button--sm" type="submit">
                          退出登录
                        </button>
                      </form>
                    </div>`
                : ""
            }
          </div>
        </header>
        <main class="app-main">${body}</main>
      </body>
    </html>`;
}
