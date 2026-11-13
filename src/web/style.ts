import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Layout and Markdown rules layered on top of HeroUI. Element-level rules live in `@layer base`
 * so HeroUI component classes (which sit in `@layer components`) still win over them; unlayered
 * rules would beat every HeroUI rule regardless of specificity.
 */
const SITE_CSS = `
:root { color-scheme: light; --highlight: oklch(0.96 0.08 95); --header-height: 56px; }

@layer base {
  body { margin: 0; background: var(--background); color: var(--foreground); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; font-size: 14px; line-height: 1.6; }
  a { color: var(--accent); text-decoration: none; text-underline-offset: .2em; }
  a:hover { text-decoration: underline; }
  h1, h2, h3 { color: var(--foreground); }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
  ::selection { background: var(--accent-soft); color: var(--accent-soft-foreground); }
}

.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.nowrap { white-space: nowrap; }

/* App shell */
.app-header { position: sticky; top: 0; z-index: 10; min-height: var(--header-height); background: var(--surface); border-bottom: 1px solid var(--separator); }
.app-header__inner { max-width: 1440px; min-height: var(--header-height); margin: 0 auto; padding: 0 24px; display: flex; align-items: center; gap: 28px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; color: var(--foreground); }
.brand:hover { text-decoration: none; }
.brand__mark { display: inline-grid; place-items: center; height: 26px; padding: 0 7px; border-radius: 4px; background: var(--accent); color: var(--accent-foreground); font-size: 12px; letter-spacing: .02em; }
.app-nav { display: flex; align-self: stretch; gap: 20px; flex: 1; }
.app-nav__link { display: inline-flex; align-items: center; padding: 0 2px; border-bottom: 2px solid transparent; color: var(--muted); font-weight: 500; white-space: nowrap; }
.app-nav__link:hover { color: var(--foreground); text-decoration: none; }
.app-nav__link[aria-current="page"] { color: var(--foreground); border-bottom-color: var(--accent); }
.app-main { max-width: 1440px; margin: 0 auto; padding: 24px 24px 80px; }
a.button:hover { text-decoration: none; }
.card.card--default { border: 1px solid var(--separator); border-radius: 6px; box-shadow: none; }
.button, .input, .textarea, .alert { border-radius: 6px; box-shadow: none; }
.button:focus-visible, .input:focus-visible, .textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

/* Native disclosures retain their marker and keyboard behavior. */
details > summary { cursor: pointer; color: var(--foreground); font-weight: 600; }
details > summary:hover { color: var(--accent); }
details[open] > summary { margin-bottom: 12px; }

.page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px 32px; margin-bottom: 20px; }
.page-head h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
.page-head p { margin: 0; }
.overall { min-width: 280px; flex: 0 1 360px; }
.section-title { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
.card > .section-title { margin: 0; }

/* Status / severity chips */
.user-menu { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 13px; }
.user-menu a[aria-current="page"] { color: var(--foreground); text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 5px; }
.user-menu form { margin: 0; }
.chip--id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* List page */
.list-layout { display: grid; grid-template-columns: 264px minmax(0, 1fr); gap: 24px; align-items: start; }
.group-nav { position: sticky; top: calc(var(--header-height) + 16px); max-height: calc(100vh - var(--header-height) - 32px); overflow-y: auto; padding: 8px; gap: 0; }
.group-nav__section { padding: 12px 10px 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
.group-nav__link { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px 8px; padding: 6px 10px; border-radius: 4px; color: var(--foreground); overflow-wrap: anywhere; }
.group-nav__link:hover { background: var(--default); text-decoration: none; }
.group-nav__link[aria-current="true"] { background: var(--accent-soft); color: var(--accent-soft-foreground); }
.group-nav__count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.group-nav__link .progress-bar { grid-column: 1 / -1; }

.status-tabs { display: flex; flex-wrap: wrap; gap: 0 20px; border-bottom: 1px solid var(--separator); max-width: 100%; }
.status-tabs .tabs__tab { width: auto; gap: 6px; padding: 8px 2px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--muted); background: transparent; box-shadow: none; }
.status-tabs .tabs__tab:hover { color: var(--foreground); text-decoration: none; }
.status-tabs .tabs__tab[aria-current="true"] { color: var(--foreground); background: transparent; border-bottom-color: var(--accent); box-shadow: none; }
.tab-count { font-size: 12px; font-variant-numeric: tabular-nums; opacity: .7; }

.filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
.filter-bar .input[type="search"] { flex: 1 1 260px; max-width: 420px; }
select.input { appearance: none; padding-right: 32px; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: right 16px center, right 11px center; background-size: 5px 5px; background-repeat: no-repeat; cursor: pointer; }
.result-count { margin-left: auto; color: var(--muted); font-size: 13px; }

.items { background: var(--surface); border: 1px solid var(--separator); border-radius: 6px; box-shadow: none; padding: 4px 8px 8px; }
.items .table__row { position: relative; }
.items .table__cell { padding: 10px 12px; vertical-align: top; }
.items .table__column { white-space: nowrap; }
.items .col-id { width: 84px; white-space: nowrap; }
.items .col-num { width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
.items .col-time { width: 128px; white-space: nowrap; }
.items .col-chip { width: 96px; }
.items .col-status { width: 132px; }
.item-link { color: var(--foreground); font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.item-link::after { content: ""; position: absolute; inset: 0; }
.item-link:hover { text-decoration: none; }
.items .table__row:hover .item-link { color: var(--accent); }
.item-group { display: block; margin-top: 2px; font-size: 12px; color: var(--muted); }
.status-cell { display: flex; flex-wrap: wrap; gap: 4px; }
.empty-state { padding: 48px 16px; text-align: center; color: var(--muted); }

/* Detail page */
.detail-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.breadcrumbs { flex-wrap: wrap; }
.breadcrumbs__separator { width: auto; height: auto; }
.pager { display: flex; align-items: center; gap: 8px; }
.pager__position { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; padding: 0 4px; }
.button[aria-disabled="true"] { pointer-events: none; }

.item-head { margin-bottom: 20px; }
.item-head__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.item-head h1 { margin: 0; font-size: 22px; line-height: 1.45; font-weight: 600; }
.detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; align-items: start; }
.detail-main, .detail-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.detail-main { grid-column: 1; grid-row: 1; }
.detail-side { grid-column: 2; grid-row: 1; position: sticky; top: calc(var(--header-height) + 16px); max-height: calc(100vh - var(--header-height) - 32px); overflow-y: auto; padding: 2px; margin: -2px; }
.card--padded { padding: 20px; }

.fields { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px 16px; margin: 0; }
.fields dt { color: var(--muted); }
.fields dd { margin: 0; }
.links-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
a.ref { white-space: nowrap; }

.excerpts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); align-items: start; gap: 12px; }
.excerpt { min-width: 0; border: 1px solid var(--separator); border-radius: 4px; overflow: hidden; }
.excerpt__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 10px; padding: 8px 12px; font-size: 12px; background: var(--surface-secondary); border-bottom: 1px solid var(--separator); }
.excerpt__file { overflow-wrap: anywhere; font-weight: 500; }
.excerpt__diff { font-size: 12px; white-space: nowrap; }
.excerpt__lines { padding: 4px 0; }
.excerpt__line { display: grid; grid-template-columns: 48px minmax(0, 1fr); font-size: 13px; line-height: 1.7; }
.excerpt__line.is-hit { background: var(--highlight); }
.excerpt__number { padding-right: 12px; text-align: right; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; user-select: none; }
.excerpt__line.is-hit .excerpt__number { color: var(--foreground); font-weight: 600; }
.excerpt__text { padding-right: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.excerpt__gap { display: block; padding: 2px 12px; font-size: 12px; background: var(--surface-secondary); text-align: center; }

.card.card--default.conclusion { border-color: var(--success); }
.card.card--default.conclusion.is-stale { border-color: var(--danger); }
.conclusion__body, .entry__body { overflow-wrap: anywhere; }
.conclusion__meta { font-size: 12px; color: var(--muted); }

.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.entry { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 14px 0; border-top: 1px solid var(--separator); scroll-margin-top: calc(var(--header-height) + 16px); }
.entry:first-child { border-top: 0; padding-top: 4px; }
.entry:target { background: var(--highlight); border-radius: 4px; }
.entry__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-bottom: 4px; font-size: 13px; }
.entry__author { font-weight: 600; }
.entry--clarification .entry__body { padding: 8px 12px; border-radius: 4px; background: var(--surface-secondary); }

.form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field__label { font-size: 13px; font-weight: 500; }
.field__hint { font-size: 12px; color: var(--muted); }
.form .textarea { resize: vertical; min-height: 120px; }
.form-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.composer { margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--separator); }

.readonly-note { margin: 0; font-size: 13px; color: var(--muted); }

/* Sign-in and account pages */
.narrow { max-width: 420px; margin: 48px auto 0; }
.narrow h1 { margin: 0 0 16px; font-size: 20px; font-weight: 600; }
.profile { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 6px 12px; margin: 0 0 20px; }
.profile dt { color: var(--muted); }
.profile dd { margin: 0; }

.alert { margin-bottom: 16px; }
.form .alert { margin: 0; }
.alert__title { margin: 0; }

/* Document pages */
.docs-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 24px; align-items: start; }
.doc-card { padding: 28px 32px 32px; }
.doc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.doc-tile { color: var(--foreground); }
.doc-tile:hover { text-decoration: none; border-color: var(--accent); }
.doc-tile__revs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

/* Document revisions and diff viewer */
.rev-tabs { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0 16px; border-bottom: 1px solid var(--separator); }
.rev-tabs__link { padding: 6px 2px; border-bottom: 2px solid transparent; color: var(--muted); font-size: 13px; font-weight: 500; white-space: nowrap; }
.rev-tabs__link:hover { color: var(--foreground); text-decoration: none; }
.rev-tabs__link[aria-current="true"] { color: var(--foreground); border-bottom-color: var(--accent); }
.rev-notice { margin-bottom: 14px; padding: 8px 12px; border: 1px solid var(--separator); border-radius: 4px; background: var(--surface-secondary); color: var(--muted); font-size: 13px; }

.diff { border: 1px solid var(--separator); border-radius: 4px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6; }
.diff__row { display: grid; grid-template-columns: 44px 44px 20px minmax(0, 1fr); }
.diff__row--add { background: oklch(0.95 0.05 145); }
.diff__row--del { background: oklch(0.95 0.05 25); }
.diff__num { padding: 0 8px 0 4px; text-align: right; color: var(--muted); font-size: 12px; user-select: none; border-right: 1px solid var(--separator); }
.diff__sign { text-align: center; color: var(--muted); user-select: none; }
.diff__row--add .diff__sign { color: oklch(0.45 0.14 145); }
.diff__row--del .diff__sign { color: oklch(0.48 0.16 25); }
.diff__code { padding: 0 10px 0 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff__code del { background: oklch(0.86 0.12 25); text-decoration: none; border-radius: 2px; }
.diff__code ins { background: oklch(0.86 0.12 145); text-decoration: none; border-radius: 2px; }
.diff-Hunk-expand { border-top: 1px solid var(--separator); border-bottom: 1px solid var(--separator); }
.diff-Hunk-expand:first-child { border-top: 0; }
.diff-Hunk-expand:last-child { border-bottom: 0; }
.diff__expand { padding: 4px 12px; background: var(--surface-secondary); color: var(--muted); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; font-size: 12px; font-weight: 500; }
.diff-Hunk-expand[open] > .diff__expand { margin-bottom: 0; border-bottom: 1px solid var(--separator); }
.prose { overflow-wrap: anywhere; }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
.prose :is(h1, h2, h3, h4, h5, h6) { margin: 1.4em 0 .5em; font-weight: 600; line-height: 1.4; }
.prose h1 { font-size: 22px; }
.prose h2 { font-size: 18px; padding-bottom: 6px; border-bottom: 1px solid var(--separator); }
.prose h3 { font-size: 16px; }
.prose :is(h4, h5, h6) { font-size: 14px; }
.prose :is(p, ul, ol, table, blockquote, pre) { margin: .6em 0; }
.prose ul { list-style: disc; padding-left: 1.6em; }
.prose ol { list-style: decimal; padding-left: 1.6em; }
.prose li + li { margin-top: .25em; }
.prose code { padding: 1px 6px; border-radius: 6px; background: var(--default); font-size: .92em; }
.prose pre { padding: 12px 16px; border-radius: 4px; background: var(--default); overflow-x: auto; }
.prose pre code { padding: 0; background: none; }
.prose blockquote { padding-left: 12px; border-left: 3px solid var(--separator); color: var(--muted); }
.prose hr { border: 0; border-top: 1px solid var(--separator); margin: 1.5em 0; }
.prose table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; font-size: 13px; }
.prose :is(th, td) { border: 1px solid var(--separator); padding: 6px 10px; text-align: left; vertical-align: top; }
.prose th { background: var(--surface-secondary); font-weight: 600; }
.prose img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--separator); }

.doc { padding-left: 56px; }
.doc > [data-line] { position: relative; }
.doc > [data-line]::before { content: attr(data-line); position: absolute; left: -56px; width: 40px; text-align: right; color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.9; opacity: .7; }
.doc tr[data-line] > :first-child { position: relative; }
.doc .hl, .doc tr.hl > * { background: var(--highlight); }
.doc .hl:not(table, tr) { border-radius: 4px; box-shadow: -8px 0 0 var(--highlight), 8px 0 0 var(--highlight); }
.doc :target { scroll-margin-top: calc(var(--header-height) + 24px); }

@media (max-width: 1100px) {
  .detail-layout { grid-template-columns: minmax(0, 1fr); }
  .detail-main, .detail-side { grid-column: auto; grid-row: auto; }
  .detail-side { position: static; max-height: none; overflow: visible; }
}
@media (max-width: 900px) {
  .app-header { position: static; }
  .app-header__inner { gap: 0 16px; padding: 8px 16px; flex-wrap: wrap; }
  .brand { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .app-nav { order: 2; flex: 1 1 auto; min-height: 40px; gap: 16px; }
  .user-menu { order: 3; flex: 1 1 100%; flex-wrap: wrap; gap: 4px; margin: 0; }
  .user-menu .button { max-width: 100%; white-space: normal; }
  .list-layout, .docs-layout { grid-template-columns: minmax(0, 1fr); }
  .group-nav { position: static; max-height: 320px; }
  .items .col-time, .items .col-num { display: none; }
}
@media (max-width: 640px) {
  .app-main { padding: 16px 16px 64px; }
  .items .col-chip { display: none; }
  .doc-card { padding: 20px 16px; }
  .doc { padding-left: 0; }
  .doc > [data-line]::before { display: none; }
}
`;

export interface Stylesheet {
  /** Content-hashed path, so responses can be cached indefinitely. */
  href: string;
  css: string;
}

function stylesheet(name: string, css: string): Stylesheet {
  const hash = createHash("sha256").update(css).digest("hex").slice(0, 12);
  return { href: `/assets/${name}.${hash}.css`, css };
}

/** `dist/heroui.min.css` is not in the package's `exports`, so resolve it from the package root. */
const heroUiRoot = dirname(createRequire(import.meta.url).resolve("@heroui/styles/package.json"));

/** In cascade order: HeroUI's prebuilt bundle (Tailwind preflight, theme, components), then the site rules. */
export const STYLESHEETS: readonly Stylesheet[] = [
  stylesheet("heroui", readFileSync(join(heroUiRoot, "dist/heroui.min.css"), "utf8")),
  stylesheet("site", SITE_CSS),
];
