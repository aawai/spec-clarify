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
:root {
  color-scheme: light;
  --highlight: oklch(0.96 0.08 95);
  --header-height: 56px;
  --background: oklch(96.4% 0.004 255);
  --foreground: oklch(21.5% 0.015 255);
  --surface: oklch(100% 0 0);
  --surface-foreground: var(--foreground);
  --surface-secondary: oklch(94.6% 0.005 255);
  --surface-secondary-foreground: var(--foreground);
  --surface-tertiary: oklch(92.8% 0.006 255);
  --surface-tertiary-foreground: var(--foreground);
  --default: oklch(93.4% 0.005 255);
  --default-foreground: var(--foreground);
  --border: oklch(88.5% 0.008 255);
  --separator: oklch(91% 0.006 255);
  --muted: oklch(47.5% 0.015 255);
  --line-number: oklch(51% 0.014 255);
  --field-foreground: var(--foreground);
  --field-placeholder: var(--muted);
  --field-border-width: 1px;
  --field-border: var(--border);
  --field-border-hover: color-mix(in oklab, var(--border) 68%, var(--foreground) 32%);
  --field-border-focus: var(--focus);
  --accent: oklch(48% 0.155 262);
  --accent-foreground: var(--snow);
  --accent-hover: color-mix(in oklab, var(--accent) 88%, var(--foreground) 12%);
  --accent-soft: color-mix(in oklab, var(--accent) 11%, transparent);
  --accent-soft-foreground: color-mix(in oklab, var(--accent) 72%, var(--foreground) 28%);
  --accent-soft-hover: color-mix(in oklab, var(--accent) 16%, transparent);
  --focus: var(--accent);
  --danger: oklch(51% 0.2 25);
  --danger-foreground: var(--snow);
  --danger-hover: color-mix(in oklab, var(--danger) 88%, var(--foreground) 12%);
  --danger-soft: color-mix(in oklab, var(--danger) 11%, transparent);
  --danger-soft-foreground: color-mix(in oklab, var(--danger) 75%, var(--foreground) 25%);
  --success: oklch(50% 0.145 152);
  --success-foreground: var(--snow);
  --success-hover: color-mix(in oklab, var(--success) 88%, var(--foreground) 12%);
  --success-soft: color-mix(in oklab, var(--success) 12%, transparent);
  --success-soft-foreground: color-mix(in oklab, var(--success) 65%, var(--foreground) 35%);
  --warning-soft: color-mix(in oklab, var(--warning) 15%, transparent);
  --warning-soft-foreground: color-mix(in oklab, var(--warning) 45%, var(--foreground) 55%);
}

@layer base {
  body { margin: 0; background: var(--background); color: var(--foreground); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; font-size: 14px; line-height: 1.6; }
  a { color: var(--accent); text-decoration: none; text-underline-offset: .2em; }
  a:hover { text-decoration: underline; }
  :is(.prose, .fields, .doc, .page-head p, .alert, .field__hint, .entry__deduped, .item-head__meta, .list-footer) a:not(.button):not(.chip) {
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: .2em;
    text-decoration-color: color-mix(in oklab, currentColor 48%, transparent);
  }
  :is(.prose, .fields, .doc, .page-head p, .alert, .field__hint, .entry__deduped, .item-head__meta, .list-footer) a:not(.button):not(.chip):hover {
    text-decoration-color: currentColor;
  }
  h1, h2, h3 { color: var(--foreground); }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
  ::selection { background: var(--accent-soft); color: var(--accent-soft-foreground); }
}

.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.nowrap { white-space: nowrap; }
.skip-link { position: fixed; left: -9999px; top: 8px; z-index: 30; padding: 8px 14px; border-radius: 6px; background: var(--accent); color: var(--accent-foreground); font-weight: 600; font-size: 13px; }
.skip-link:focus { left: 16px; outline: 2px solid var(--focus); outline-offset: 2px; text-decoration: none; }
.kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; border: 1px solid color-mix(in oklab, currentColor 28%, transparent); background: color-mix(in oklab, currentColor 12%, transparent); color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; line-height: 1; }

/* App shell */
.app-header { position: sticky; top: 0; z-index: 10; min-height: var(--header-height); background: var(--surface-secondary); border-bottom: 1px solid var(--border); }
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
.button--secondary { --button-bg: var(--surface); --button-bg-hover: var(--surface-secondary); --button-bg-pressed: var(--surface-tertiary); --button-fg: var(--foreground); border: 1px solid var(--border); }
.button--secondary:hover { border-color: var(--field-border-hover); }
.button--tertiary { --button-bg: var(--default); --button-bg-hover: var(--surface-tertiary); --button-bg-pressed: var(--surface-tertiary); --button-fg: var(--foreground); border: 1px solid transparent; }
.input, .textarea { border: 1px solid var(--field-border); background-color: var(--field-background); }
.input:hover:not(:focus):not(:disabled), .textarea:hover:not(:focus):not(:disabled) { border-color: var(--field-border-hover); }
.input:focus, .textarea:focus { border-color: var(--field-border-focus); outline: 2px solid color-mix(in oklab, var(--focus) 25%, transparent); outline-offset: 0; }
.alert { border: 1px solid var(--separator); background-color: var(--surface); }
.alert--accent { background-color: color-mix(in oklab, var(--accent) 8%, var(--surface)); border-color: color-mix(in oklab, var(--accent) 28%, var(--separator)); }
.alert--danger { background-color: color-mix(in oklab, var(--danger) 8%, var(--surface)); border-color: color-mix(in oklab, var(--danger) 30%, var(--separator)); }
.alert--success { background-color: color-mix(in oklab, var(--success) 10%, var(--surface)); border-color: color-mix(in oklab, var(--success) 32%, var(--separator)); }
.button:focus-visible, .input:focus-visible, .textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }

/* Native disclosures retain their marker and keyboard behavior. */
details > summary { cursor: pointer; color: var(--foreground); font-weight: 600; }
details > summary:hover { color: var(--accent); }
details[open] > summary { margin-bottom: 12px; }

.page-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px 32px; margin-bottom: 20px; }
.page-head h1 { margin: 0 0 4px; font-size: 24px; line-height: 1.3; font-weight: 600; letter-spacing: -.015em; }
.page-head p { margin: 0; }
.overall { min-width: 280px; flex: 0 1 360px; display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
.overall .button { align-self: flex-start; }
.section-title { margin: 0 0 14px; font-size: 16px; line-height: 1.4; font-weight: 600; }
.card > .section-title { margin: 0; }

/* Status / severity chips */
.user-menu { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 13px; }
.user-menu a[aria-current="page"] { color: var(--foreground); text-decoration: underline; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 5px; }
.user-menu form { margin: 0; }
.chip--id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.chip--role { font-size: 11px; height: 20px; padding-inline: 6px; }

/* List page */
.list-layout { display: grid; grid-template-columns: 264px minmax(0, 1fr); gap: 24px; align-items: start; }
.card.card--default.group-nav { background: var(--surface-secondary); border-color: var(--border); }
.group-nav { position: sticky; top: calc(var(--header-height) + 16px); max-height: calc(100vh - var(--header-height) - 32px); overflow-y: auto; padding: 8px; gap: 0; }
.group-nav__section { padding: 12px 10px 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
.group-nav__link { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 8px; padding: 6px 10px; border-radius: 4px; color: var(--foreground); overflow-wrap: anywhere; }
.group-nav__link:hover { background: var(--surface); text-decoration: none; }
.group-nav__link[aria-current="true"] { background: var(--accent-soft); color: var(--accent-soft-foreground); }
.group-nav__counts { display: inline-flex; align-items: center; gap: 6px; }
.group-nav__badge { padding: 1px 6px; border-radius: 999px; background: var(--warning-soft); color: var(--warning-soft-foreground); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.group-nav__badge--accent { background: var(--accent-soft); color: var(--accent-soft-foreground); }
.group-nav__badge.is-zero { background: var(--default); color: var(--muted); font-weight: 400; }
.group-nav__count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.group-nav__link .progress-bar { grid-column: 1 / -1; }
.progress-bar__awaiting { border-radius: inherit; background-color: var(--accent); height: 100%; inset-inline-start: 0; position: absolute; top: 0; }

.group-nav-mobile { display: none; background: var(--surface-secondary); border-color: var(--border); padding: 0; }
.group-nav-mobile__summary { display: flex; align-items: center; gap: 8px; padding: 10px 14px; min-height: 40px; list-style: none; }
.group-nav-mobile__summary::-webkit-details-marker { display: none; }
.group-nav-mobile__summary::before { content: "▸"; font-size: 12px; color: var(--muted); flex-shrink: 0; }
.group-nav-mobile[open] > .group-nav-mobile__summary { margin-bottom: 0; border-bottom: 1px solid var(--separator); }
.group-nav-mobile[open] > .group-nav-mobile__summary::before { content: "▾"; }
.group-nav-mobile__meta { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
.group-nav-mobile__list { display: flex; flex-direction: column; padding: 8px; max-height: 50vh; overflow-y: auto; }

.status-bar { display: flex; flex-direction: column; gap: 6px; }
.status-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 16px; border-bottom: 1px solid var(--separator); max-width: 100%; }
.status-tabs__group { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0 14px; }
.status-tabs__group--views .tabs__tab { font-weight: 600; }
.status-tabs__group--states .tabs__tab { font-size: 13px; }
.status-tabs__sep { width: 1px; height: 16px; background: var(--border); flex-shrink: 0; }
.status-tabs .tabs__tab { width: auto; gap: 6px; padding: 8px 2px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--muted); background: transparent; box-shadow: none; }
.status-tabs .tabs__tab:hover { color: var(--foreground); text-decoration: none; }
.status-tabs .tabs__tab[aria-current="true"] { color: var(--foreground); background: transparent; border-bottom-color: var(--accent); box-shadow: none; }
.tab-count { font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--muted); }
.status-hint { margin: 0; font-size: 12px; line-height: 1.5; }

.filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
.filter-bar .input, .filter-bar .button { height: 36px; box-sizing: border-box; }
.filter-bar .input { padding-block: 0; }
.filter-bar .input[type="search"] { flex: 1 1 260px; max-width: 420px; }
select.input { appearance: none; padding-right: 32px; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: right 16px center, right 11px center; background-size: 5px 5px; background-repeat: no-repeat; cursor: pointer; }
.result-count { margin-left: auto; color: var(--muted); font-size: 13px; }

.items { background: var(--surface); border: 1px solid var(--separator); border-radius: 6px; box-shadow: none; padding: 0 8px 8px; overflow: clip; }
.items .table__scroll-container { overflow: visible; }
.items .table__header th { position: sticky; top: var(--header-height); z-index: 2; background: var(--surface-secondary); box-shadow: inset 0 -1px 0 var(--border); }
.items .table__row { position: relative; }
.items .table__cell { padding: 10px 12px; vertical-align: top; }
.items .table__column { white-space: nowrap; }
.items .col-id { position: relative; z-index: 1; width: 84px; white-space: nowrap; }
.items .col-num { width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
.items .col-time { width: 128px; white-space: nowrap; }
.items .col-chip { width: 96px; }
.items .col-status { width: 132px; }
.item-link { color: var(--foreground); font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.item-link::after { content: ""; position: absolute; inset: 0; }
.item-link:hover { text-decoration: none; }
.items .item-link:focus-visible { outline: none; }
.items .table__row:hover .item-link, .items .table__row:has(.item-link:focus-visible) .item-link { color: var(--accent); }
.items .table__row:has(.item-link:focus-visible) .table__cell { background-color: var(--accent-soft); }
.items .table__row:has(.item-link:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }
.item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 2px; font-size: 12px; color: var(--muted); }
.item-severity-mobile { display: none; }
.status-cell { display: flex; flex-wrap: wrap; gap: 4px; }
.empty-state { padding: 48px 16px; text-align: center; color: var(--muted); }

.list-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-top: 12px; font-size: 13px; color: var(--muted); }
.list-footer__range { font-variant-numeric: tabular-nums; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pagination__pages { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.pagination__page { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 30px; padding: 0 8px; border-radius: 6px; border: 1px solid transparent; color: var(--foreground); font-variant-numeric: tabular-nums; font-size: 13px; }
.pagination__page:hover { background: var(--surface-secondary); text-decoration: none; }
.pagination__page[aria-current="page"] { background: var(--accent); color: var(--accent-foreground); font-weight: 600; }
.pagination__ellipsis { padding: 0 4px; color: var(--muted); }

/* Detail page */
.detail-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.breadcrumbs { flex-wrap: wrap; }
.breadcrumbs__separator { width: auto; height: auto; }
.pager { display: flex; align-items: center; gap: 8px; }
.pager__position { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; padding: 0 4px; }
.button[aria-disabled="true"] { pointer-events: none; }

.item-head { margin-bottom: 16px; }
.item-head h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.35; font-weight: 600; letter-spacing: -.015em; }
.item-head__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mobile-jump { display: none; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) 448px; gap: 24px; align-items: start; }
.detail-main, .detail-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.detail-main { grid-column: 1; grid-row: 1; }
.detail-side { grid-column: 2; grid-row: 1; position: sticky; top: calc(var(--header-height) + 16px); max-height: calc(100vh - var(--header-height) - 32px); overflow-y: auto; padding: 2px; margin: -2px; }
#clarify, #comment, #current-clarification, #sources { scroll-margin-top: calc(var(--header-height) + 16px); }
.card--padded { padding: 20px 24px; }

.fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 20px; margin: 0; }
.fields dt { color: var(--muted); }
.fields dd { margin: 0; }
.links-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
a.ref { white-space: nowrap; }

.excerpts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); align-items: start; gap: 12px; }
.excerpt { min-width: 0; border-radius: 6px; overflow: hidden; background: var(--background); }
.excerpt__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 10px; padding: 8px 12px; font-size: 12px; background: var(--surface-secondary); border-bottom: 1px solid var(--separator); }
.excerpt__file { overflow-wrap: anywhere; font-weight: 500; }
.excerpt__diff { font-size: 12px; white-space: nowrap; }
.excerpt__lines { padding: 0; }
.excerpt__line { display: grid; grid-template-columns: 48px minmax(0, 1fr); padding: 2px 0; font-size: 13px; line-height: 1.65; }
.excerpt__line.is-hit { background: var(--highlight); }
.excerpt__number { padding: 0 10px 0 8px; text-align: right; color: var(--line-number); background: var(--surface-secondary); border-right: 1px solid var(--separator); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-variant-numeric: tabular-nums; user-select: none; }
.excerpt__line.is-hit .excerpt__number { background: color-mix(in oklab, var(--highlight) 70%, var(--surface-secondary) 30%); color: var(--foreground); font-weight: 600; }
.excerpt__text { padding: 0 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.excerpt__gap { display: block; padding: 4px 12px; font-size: 12px; background: var(--surface-secondary); border-top: 1px solid var(--separator); border-bottom: 1px solid var(--separator); text-align: center; }

.card.card--default.conclusion { border-color: color-mix(in oklab, var(--success) 32%, var(--separator)); background: color-mix(in oklab, var(--success) 5%, var(--surface)); }
.card.card--default.conclusion.is-stale { border-color: color-mix(in oklab, var(--danger) 35%, var(--separator)); background: color-mix(in oklab, var(--danger) 5%, var(--surface)); }
.conclusion__body, .entry__body { overflow-wrap: anywhere; }
.conclusion__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }

.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.entry { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 14px 0; border-top: 1px solid var(--separator); scroll-margin-top: calc(var(--header-height) + 16px); }
.entry:first-child { border-top: 0; padding-top: 4px; }
.entry:target { background: var(--highlight); border-radius: 4px; }
.entry__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-bottom: 4px; font-size: 13px; }
.entry__author { font-weight: 600; }
.entry__deduped { margin: 0; font-size: 13px; }
.entry--clarification .entry__body { padding: 8px 12px; border-radius: 4px; background: var(--surface-secondary); }

.form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field__label-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; }
.field__label { font-size: 13px; font-weight: 500; }
.field__hint { font-size: 12px; color: var(--muted); }
.form .textarea { resize: vertical; min-height: 100px; }
.form .clarify-textarea { min-height: 168px; }
.clarify-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 2px; }
.clarify-actions__stay { align-self: flex-start; }
.form-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.conflict-latest { margin-top: 10px; padding: 10px 12px; border: 1px solid color-mix(in oklab, var(--danger) 28%, var(--separator)); border-radius: 6px; background: var(--surface); }
.conflict-latest__label { font-size: 12px; font-weight: 600; color: var(--danger-soft-foreground); margin-bottom: 4px; }
.conflict-latest__body { font-size: 13px; }
.readonly-note { margin: 0; font-size: 13px; color: var(--muted); }

/* Sign-in and account pages */
.narrow { max-width: 420px; margin: 32px auto 0; }
.narrow h1 { margin: 0 0 16px; font-size: 22px; font-weight: 600; }
.login-card { margin: clamp(48px, 12vh, 120px) auto 0; }
.login-head { margin-bottom: 4px; }
.login-head h1 { margin: 0; font-size: 24px; font-weight: 600; line-height: 1.3; letter-spacing: -.015em; }
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
.rev-tabs { display: flex; flex-wrap: wrap; gap: 6px 8px; margin: 12px 0 16px; padding-bottom: 12px; border-bottom: 1px solid var(--separator); }
.rev-tabs__link { padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-secondary); color: var(--foreground); font-size: 13px; font-weight: 500; white-space: nowrap; }
.rev-tabs__link:hover { border-color: var(--field-border-hover); text-decoration: none; }
.rev-tabs__link[aria-current="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-soft-foreground); }
.rev-notice { margin-bottom: 14px; padding: 8px 12px; border: 1px solid var(--separator); border-radius: 4px; background: var(--surface-secondary); color: var(--muted); font-size: 13px; }

.diff { border-radius: 6px; overflow: hidden; background: var(--background); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.65; }
.diff__row { display: grid; grid-template-columns: 48px 48px 28px minmax(0, 1fr); padding: 2px 0; }
.diff__row--add { background: oklch(0.95 0.05 145); }
.diff__row--del { background: oklch(0.95 0.05 25); }
.diff__num { padding: 0 10px 0 6px; text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; user-select: none; border-right: 1px solid var(--separator); }
.diff__sign { text-align: center; color: var(--muted); user-select: none; }
.diff__row--add .diff__sign { color: oklch(0.45 0.14 145); }
.diff__row--del .diff__sign { color: oklch(0.48 0.16 25); }
.diff__code { padding: 0 12px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff__code del { background: oklch(0.86 0.12 25); text-decoration: none; border-radius: 2px; }
.diff__code ins { background: oklch(0.86 0.12 145); text-decoration: none; border-radius: 2px; }
.diff__fold { border-top: 1px solid var(--separator); border-bottom: 1px solid var(--separator); }
.diff__fold:first-child { border-top: 0; }
.diff__fold:last-child { border-bottom: 0; }
.diff__expand { padding: 6px 12px; background: var(--surface-secondary); color: var(--muted); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; font-size: 12px; font-weight: 500; }
.diff__fold[open] > .diff__expand { margin-bottom: 0; border-bottom: 1px solid var(--separator); }
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

.doc { max-width: 76ch; padding-left: 56px; }
.doc > [data-line] { position: relative; }
.doc > [data-line]::before { content: attr(data-line); position: absolute; left: -56px; width: 40px; text-align: right; color: var(--line-number); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.9; }
.doc tr[data-line] > :first-child { position: relative; }
.doc .hl, .doc tr.hl > * { background: var(--highlight); }
.doc .hl:not(table, tr) { border-radius: 4px; box-shadow: -8px 0 0 var(--highlight), 8px 0 0 var(--highlight); }
.doc :target { scroll-margin-top: calc(var(--header-height) + 24px); }

@media (max-width: 1100px) {
  .detail-layout { grid-template-columns: minmax(0, 1fr); }
  .detail-main, .detail-side { grid-column: auto; grid-row: auto; }
  .detail-side { position: static; max-height: none; overflow: visible; }
  .mobile-jump { display: flex; }
  #clarify, #comment, #current-clarification, #sources { scroll-margin-top: 16px; }
}
@media (max-width: 900px) {
  .app-header { position: static; }
  .app-header__inner { gap: 4px 10px; padding: 6px 16px 0; flex-wrap: wrap; }
  .brand { order: 1; margin-right: auto; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .user-menu { order: 2; flex: 0 1 auto; margin-left: 0; gap: 6px; }
  .app-nav { order: 3; flex: 1 1 100%; min-height: 40px; gap: 16px; border-top: 1px solid var(--separator); }
  .list-layout, .docs-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .group-nav--desktop { display: none; }
  .group-nav-mobile { display: block; }
  .items .table__header th { top: 0; }
  .items .col-time, .items .col-num { display: none; }
}
@media (max-width: 640px) {
  .app-main { padding: 12px 16px 56px; }
  .page-head { gap: 10px; margin-bottom: 12px; }
  .page-head h1 { font-size: 20px; }
  .overall { min-width: 0; flex: 1 1 100%; gap: 6px; }
  .user-menu__role, .list-footer__export, .status-tabs__sep { display: none; }
  .user-menu { gap: 8px; }
  .user-menu .button { padding-inline: 10px; min-height: 40px; height: auto; font-size: 13px; }
  .app-nav__link { min-height: 44px; }
  .status-tabs { gap: 0 12px; }
  .status-tabs__group { gap: 0 12px; }
  .status-tabs .tabs__tab { padding: 8px 2px; min-height: 40px; }
  .filter-bar { margin: 8px 0 10px; }
  .items .col-chip { display: none; }
  .item-severity-mobile { display: inline-flex; }
  .detail-top { gap: 8px; margin-bottom: 12px; }
  .mobile-jump .button, .pager .button { min-height: 40px; }
  .kbd { display: none; }
  details > summary { padding-block: 4px; }
  .doc-card { padding: 18px 16px; }
  .doc { padding-left: 34px; }
  .doc > [data-line]::before { left: -34px; width: 26px; font-size: 11px; }
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
