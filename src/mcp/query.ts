import { itemState, STATUS_LABELS, type ItemStatus } from "../clarification.js";
import {
  loadWorkspace,
  type ProjectConfig,
  type SourceDocument,
  type Workspace,
} from "../project.js";
import { diffStats, formatUnifiedDiff, type DiffStats } from "../render/diff.js";
import { buildExcerpts, type DocRef, type Excerpt } from "../render/excerpt.js";
import { createReviewRenderer, type RefEnv } from "../render/markdown.js";
import type { ReviewField, ReviewItem } from "../review/model.js";
import {
  ENTRY_LABELS,
  RESOLUTION_LABELS,
  type Entry,
  type EntryStore,
  type ItemActivity,
  type Resolution,
  type ResolutionAction,
} from "../store/entries.js";
import { ROLE_LABELS, type Role } from "../store/users.js";

export type ListFilterStatus = ItemStatus | "awaiting" | "pending" | "all";

export interface McpContext {
  config: ProjectConfig;
  entries: EntryStore;
}

/** Raised for missing items, documents, revisions, or invalid query parameters. */
export class QueryError extends Error {}

export interface ListItemsInput {
  status?: ListFilterStatus;
  applied?: boolean;
  afterClarificationId?: number;
  group?: string;
  severity?: string;
  q?: string;
  includeBody?: boolean;
  limit?: number;
  offset?: number;
}

export interface ItemResolutionDetail {
  id: number;
  clarificationId: number;
  action: ResolutionAction;
  actionLabel: string;
  actor: string;
  note: string;
  createdAt: string;
}

export interface ItemSummary {
  id: string;
  title: string;
  groupKey: string;
  groupTitle: string;
  severity?: string;
  status: ItemStatus;
  statusLabel: string;
  awaitingReply: boolean;
  applied: boolean;
  entryCount: number;
  lastActivity?: string;
  latestClarification?: {
    id: number;
    author: string;
    role: Role;
    roleLabel: string;
    body: string;
    stale: boolean;
    createdAt: string;
  };
  latestResolution?: ItemResolutionDetail;
  fields?: ReviewField[];
  body?: string;
}

export interface ListItemsResult {
  projectTitle: string;
  total: number;
  offset: number;
  limit: number;
  summary: {
    total: number;
    open: number;
    clarified: number;
    stale: number;
    awaitingReply: number;
    pending: number;
    applied: number;
    unappliedClarified: number;
  };
  groups: Array<{
    key: string;
    title: string;
    section: string;
    total: number;
    clarified: number;
    pending: number;
  }>;
  items: ItemSummary[];
}

export interface ItemEntryDetail {
  id: number;
  kind: Entry["kind"];
  kindLabel: string;
  author: string;
  role: Role;
  roleLabel: string;
  body: string;
  itemDigest: string;
  stale: boolean;
  createdAt: string;
}

export interface GetItemResult {
  id: string;
  title?: string;
  removedFromReview?: boolean;
  group?: {
    key: string;
    title: string;
    section: string;
    source: string;
  };
  line?: number;
  endLine?: number;
  severity?: string;
  defaultDocument?: string;
  digest?: string;
  status?: ItemStatus;
  statusLabel?: string;
  awaitingReply?: boolean;
  applied?: boolean;
  fields?: ReviewField[];
  body?: string;
  related?: string[];
  backlinks?: Array<{ id: string; title: string }>;
  entries: ItemEntryDetail[];
  resolutions?: ItemResolutionDetail[];
  excerpts?: Array<Excerpt & { title?: string }>;
}

export interface ListDocumentsInput {
  rev?: string;
  changedOnly?: boolean;
}

export interface DocumentRevisionSummary {
  id: string;
  label: string;
  path: string;
  changed: boolean;
  added: number;
  removed: number;
  baseId?: string;
}

export interface DocumentListEntry {
  path: string;
  title: string;
  lineCount: number;
  isReview: boolean;
  addedInRevision?: string;
  revisions: DocumentRevisionSummary[];
  statusInRevision?: "added" | "modified" | "inherited" | "not_yet_added";
}

export interface ListDocumentsResult {
  projectTitle: string;
  configuredRevisions: Array<{ id: string; label: string; dir: string }>;
  documents: DocumentListEntry[];
}

export interface GetDocumentInput {
  path: string;
  rev?: string;
  startLine?: number;
  endLine?: number;
  withLineNumbers?: boolean;
}

export interface GetDocumentResult {
  path: string;
  title: string;
  revision: {
    id: string;
    label: string;
    sourcePath: string;
    inherited: boolean;
    inheritedFrom?: string;
  };
  totalLines: number;
  startLine: number;
  endLine: number;
  content: string;
}

export interface DiffDocumentInput {
  path: string;
  rev: string;
  baseRev?: string;
  contextLines?: number;
}

export interface DiffDocumentResult {
  path: string;
  title: string;
  base: { id: string; label: string; sourcePath?: string } | null;
  target: { id: string; label: string; sourcePath: string };
  changed: boolean;
  stats: DiffStats;
  unifiedDiff: string;
  note?: string;
}

function matchesQuery(item: ReviewItem, activity: ItemActivity | undefined, q: string): boolean {
  const needle = q.toLowerCase();
  return [
    item.id,
    item.title,
    item.body ?? "",
    ...item.fields.map((field) => field.value),
    activity?.latestClarification?.body ?? "",
  ].some((text) => text.toLowerCase().includes(needle));
}

function orderedBySeverity(items: ReviewItem[], severities: readonly string[]): ReviewItem[] {
  const rank = (item: ReviewItem) => {
    const index = item.severity ? severities.indexOf(item.severity) : -1;
    return index < 0 ? severities.length : index;
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function formatEntry(entry: Entry, currentDigest?: string): ItemEntryDetail {
  return {
    id: entry.id,
    kind: entry.kind,
    kindLabel: ENTRY_LABELS[entry.kind],
    author: entry.author.displayName,
    role: entry.author.role,
    roleLabel: ROLE_LABELS[entry.author.role],
    body: entry.body,
    itemDigest: entry.itemDigest,
    stale:
      currentDigest !== undefined &&
      entry.kind === "clarification" &&
      entry.itemDigest !== currentDigest,
    createdAt: entry.createdAt,
  };
}
function formatResolution(resolution: Resolution): ItemResolutionDetail {
  return {
    id: resolution.id,
    clarificationId: resolution.clarificationId,
    action: resolution.action,
    actionLabel: RESOLUTION_LABELS[resolution.action],
    actor: resolution.actor,
    note: resolution.note,
    createdAt: resolution.createdAt,
  };
}

export async function listItems(
  ctx: McpContext,
  input: ListItemsInput = {},
): Promise<ListItemsResult> {
  const [workspace, activity] = await Promise.all([
    loadWorkspace(ctx.config),
    ctx.entries.activity(),
  ]);
  const { review } = workspace;
  const states = new Map(
    review.items.map((item) => [item.id, itemState(item, activity.get(item.id))]),
  );
  const stateOf = (item: ReviewItem) =>
    states.get(item.id) ?? { status: "open" as const, awaitingReply: false, applied: false };
  const isPending = (item: ReviewItem) => {
    const s = stateOf(item);
    return s.status === "open" || s.status === "stale" || s.awaitingReply;
  };

  let open = 0;
  let clarified = 0;
  let stale = 0;
  let awaitingReply = 0;
  let pending = 0;
  let applied = 0;
  let unappliedClarified = 0;
  for (const item of review.items) {
    const s = stateOf(item);
    if (s.status === "open") open++;
    else if (s.status === "clarified") {
      clarified++;
      if (s.applied) applied++;
      else unappliedClarified++;
    } else stale++;
    if (s.awaitingReply) awaitingReply++;
    if (isPending(item)) pending++;
  }
  const groups = review.groups.map((group) => {
    const groupItems = review.items.filter((item) => item.group === group);
    return {
      key: group.key,
      title: group.title,
      section: group.section,
      total: groupItems.length,
      clarified: groupItems.filter((item) => stateOf(item).status === "clarified").length,
      pending: groupItems.filter(isPending).length,
    };
  });

  const statusFilter = input.status ?? "all";
  const ordered =
    statusFilter === "pending"
      ? orderedBySeverity(review.items, ctx.config.severities)
      : review.items;
  const query = input.q?.trim();

  const filtered = ordered.filter((item) => {
    const s = stateOf(item);
    const statusMatches =
      statusFilter === "all" ||
      (statusFilter === "pending"
        ? s.status === "open" || s.status === "stale" || s.awaitingReply
        : statusFilter === "awaiting"
          ? s.awaitingReply
          : s.status === statusFilter);
    if (!statusMatches) return false;
    if (input.applied !== undefined && s.applied !== input.applied) return false;
    if (input.afterClarificationId !== undefined) {
      const latestClarificationId = activity.get(item.id)?.latestClarification?.id ?? 0;
      if (latestClarificationId <= input.afterClarificationId) return false;
    }
    if (input.group && item.group.key !== input.group && item.group.title !== input.group) {
      return false;
    }
    if (input.severity) {
      if (input.severity === "none" ? Boolean(item.severity) : item.severity !== input.severity) {
        return false;
      }
    }
    if (query && !matchesQuery(item, activity.get(item.id), query)) return false;
    return true;
  });

  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const paged = filtered.slice(offset, offset + limit);

  return {
    projectTitle: ctx.config.title,
    total: filtered.length,
    offset,
    limit,
    summary: {
      total: review.items.length,
      open,
      clarified,
      stale,
      awaitingReply,
      applied,
      unappliedClarified,
      pending,
    },
    groups,
    items: paged.map((item): ItemSummary => {
      const s = stateOf(item);
      const act = activity.get(item.id);
      const latest = act?.latestClarification;
      const summary: ItemSummary = {
        id: item.id,
        title: item.title,
        groupKey: item.group.key,
        groupTitle: item.group.title,
        severity: item.severity,
        status: s.status,
        statusLabel: STATUS_LABELS[s.status],
        awaitingReply: s.awaitingReply,
        applied: s.applied,
        entryCount: act?.entryCount ?? 0,
        lastActivity: act?.lastActivity,
        latestClarification: latest
          ? {
              id: latest.id,
              author: latest.author.displayName,
              role: latest.author.role,
              roleLabel: ROLE_LABELS[latest.author.role],
              body: latest.body,
              stale: latest.itemDigest !== item.digest,
              createdAt: latest.createdAt,
            }
          : undefined,
        latestResolution: act?.latestResolution
          ? formatResolution(act.latestResolution)
          : undefined,
      };
      if (input.includeBody) {
        summary.fields = item.fields;
        summary.body = item.body;
      }
      return summary;
    }),
  };
}

export async function getItem(ctx: McpContext, id: string): Promise<GetItemResult> {
  const trimmed = id.trim();
  if (!trimmed) throw new QueryError("Item ID must not be empty");
  const [workspace, itemEntries, itemResolutions] = await Promise.all([
    loadWorkspace(ctx.config),
    ctx.entries.entriesFor(trimmed),
    ctx.entries.resolutionsFor(trimmed),
  ]);
  const item = workspace.review.items.find((candidate) => candidate.id === trimmed);
  if (!item) {
    if (itemEntries.length > 0) {
      return {
        id: trimmed,
        removedFromReview: true,
        entries: itemEntries.map((entry) => formatEntry(entry)),
        resolutions: itemResolutions.map(formatResolution),
      };
    }
    throw new QueryError(`Item "${trimmed}" not found`);
  }

  let latestClarification: Entry | undefined;
  let latestCommentId: number | undefined;
  for (const entry of itemEntries) {
    if (entry.kind === "clarification") latestClarification = entry;
    else latestCommentId = entry.id;
  }
  const state = itemState(item, {
    latestClarification,
    latestCommentId,
    latestResolution: itemResolutions.at(-1),
    entryCount: itemEntries.length,
    lastActivity: itemEntries.at(-1)?.createdAt ?? "",
  });
  const refs: DocRef[] = [];
  const env: RefEnv = {
    defaultDocument: item.defaultDocument ?? item.group.defaultDocument,
    resolve: (name) => {
      const doc = workspace.resolve(name);
      if (!doc) return undefined;
      return {
        path: doc.path,
        lineCount: doc.lineCount,
        revision: doc.revision
          ? { id: doc.revision.id, basePath: doc.revision.basePath }
          : undefined,
      };
    },
    refs,
  };
  const md = createReviewRenderer();
  for (const field of item.fields) md.renderInline(field.value, env);
  if (item.body) md.render(item.body, env);
  const excerpts = buildExcerpts(refs, (path) => workspace.resolve(path)?.source).map(
    (excerpt) => ({
      ...excerpt,
      title: workspace.resolve(excerpt.path)?.title,
    }),
  );

  const backlinks = workspace.review.items
    .filter((other) => other.related.includes(item.id))
    .map((other) => ({ id: other.id, title: other.title }));

  return {
    id: item.id,
    title: item.title,
    group: {
      key: item.group.key,
      title: item.group.title,
      section: item.group.section,
      source: item.group.source,
    },
    line: item.line,
    endLine: item.endLine,
    severity: item.severity,
    defaultDocument: item.defaultDocument,
    digest: item.digest,
    status: state.status,
    statusLabel: STATUS_LABELS[state.status],
    awaitingReply: state.awaitingReply,
    applied: state.applied,
    fields: item.fields,
    body: item.body,
    related: item.related,
    backlinks,
    entries: itemEntries.map((entry) => formatEntry(entry, item.digest)),
    resolutions: itemResolutions.map(formatResolution),
    excerpts,
  };
}

export interface ResolveItemInput {
  id: string;
  clarificationId?: number;
  note?: string;
}

export interface ResolveItemsInput {
  items: ResolveItemInput[];
  action?: ResolutionAction;
  actor?: string;
  note?: string;
}

export interface ResolveItemOutcome {
  id: string;
  ok: boolean;
  resolution?: ItemResolutionDetail;
  reason?: "no_clarification" | "stale_clarification";
  latestClarification?: {
    id: number;
    author: string;
    body: string;
    createdAt: string;
  };
}

export interface ResolveItemsResult {
  total: number;
  succeeded: number;
  failed: number;
  results: ResolveItemOutcome[];
}

export async function resolveItems(
  ctx: McpContext,
  input: ResolveItemsInput,
): Promise<ResolveItemsResult> {
  if (!input.items.length) throw new QueryError("At least one item is required");
  const workspace = await loadWorkspace(ctx.config);
  const known = new Set(workspace.review.items.map((item) => item.id));
  const normalized = input.items.map((entry) => {
    const id = entry.id.trim();
    if (!id) throw new QueryError("Item ID must not be empty");
    if (!known.has(id)) throw new QueryError(`Item "${id}" not found`);
    return { ...entry, id };
  });

  const action: ResolutionAction = input.action ?? "applied";
  const actor = input.actor?.trim() || "ai";
  const results: ResolveItemOutcome[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const item of normalized) {
    const outcome = await ctx.entries.resolve({
      itemId: item.id,
      action,
      actor,
      note: item.note ?? input.note,
      clarificationId: item.clarificationId,
    });
    if (outcome.ok) {
      succeeded++;
      results.push({ id: item.id, ok: true, resolution: formatResolution(outcome.resolution) });
    } else if (outcome.reason === "no_clarification") {
      failed++;
      results.push({ id: item.id, ok: false, reason: "no_clarification" });
    } else {
      failed++;
      results.push({
        id: item.id,
        ok: false,
        reason: "stale_clarification",
        latestClarification: {
          id: outcome.latest.id,
          author: outcome.latest.author.displayName,
          body: outcome.latest.body,
          createdAt: outcome.latest.createdAt,
        },
      });
    }
  }

  return { total: results.length, succeeded, failed, results };
}

function assertRevisionId(config: ProjectConfig, revId: string): { id: string; label: string } {
  const found = config.revisions.find((rev) => rev.id === revId);
  if (!found) {
    const valid = config.revisions.map((rev) => rev.id);
    throw new QueryError(
      valid.length
        ? `Unknown revision "${revId}". Configured revisions: ${valid.join(", ")}`
        : `Unknown revision "${revId}". This project has no configured revisions.`,
    );
  }
  return found;
}

function resolveDocumentTarget(
  workspace: Workspace,
  pathOrName: string,
): { doc: SourceDocument; impliedRevId?: string } {
  const trimmed = pathOrName.trim();
  if (!trimmed) throw new QueryError("Document path must not be empty");
  const exact = workspace.documents.find((doc) => doc.path === trimmed);
  if (exact) return { doc: exact };

  const resolved = workspace.resolve(trimmed);
  if (resolved?.revision) {
    const baseDoc = workspace.documents.find((doc) => doc.path === resolved.revision!.basePath);
    if (baseDoc) return { doc: baseDoc, impliedRevId: resolved.revision.id };
  }
  if (resolved) {
    const baseDoc = workspace.documents.find((doc) => doc.path === resolved.path);
    if (baseDoc) return { doc: baseDoc };
  }
  throw new QueryError(`Document "${trimmed}" not found (or short name is ambiguous)`);
}

interface ResolvedRevisionSource {
  id: string;
  label: string;
  sourcePath: string;
  source: string;
  inherited: boolean;
  inheritedFrom?: string;
}

function resolveSourceAtRevision(
  config: ProjectConfig,
  doc: SourceDocument,
  revId: string | undefined,
): ResolvedRevisionSource {
  if (revId === undefined || revId === "baseline") {
    if (doc.addedInRevision) {
      throw new QueryError(
        `Document "${doc.path}" does not exist in baseline; it was added in revision "${doc.addedInRevision}".`,
      );
    }
    return {
      id: "baseline",
      label: "基线",
      sourcePath: doc.path,
      source: doc.source,
      inherited: false,
    };
  }

  const revCfg = assertRevisionId(config, revId);
  const targetIdx = config.revisions.findIndex((rev) => rev.id === revId);
  const addedIdx = doc.addedInRevision
    ? config.revisions.findIndex((rev) => rev.id === doc.addedInRevision)
    : -1;
  if (addedIdx > targetIdx) {
    throw new QueryError(
      `Document "${doc.path}" did not exist in revision "${revId}"; it was added in revision "${doc.addedInRevision}".`,
    );
  }

  const revs = doc.revisions ?? [];
  const active = revs.find((rev) => rev.id === revId);
  if (active) {
    return {
      id: active.id,
      label: active.label,
      sourcePath: active.path,
      source: active.source,
      inherited: false,
    };
  }

  const inheritedRev = revs
    .filter((rev) => {
      const idx = config.revisions.findIndex((cfg) => cfg.id === rev.id);
      return idx >= 0 && idx < targetIdx;
    })
    .at(-1);

  if (inheritedRev) {
    return {
      id: revCfg.id,
      label: revCfg.label,
      sourcePath: inheritedRev.path,
      source: inheritedRev.source,
      inherited: true,
      inheritedFrom: inheritedRev.id,
    };
  }

  return {
    id: revCfg.id,
    label: revCfg.label,
    sourcePath: doc.path,
    source: doc.source,
    inherited: true,
    inheritedFrom: "baseline",
  };
}

export async function listDocuments(
  ctx: McpContext,
  input: ListDocumentsInput = {},
): Promise<ListDocumentsResult> {
  const workspace = await loadWorkspace(ctx.config);
  if (input.rev) assertRevisionId(ctx.config, input.rev);
  const reviewPaths = new Set(ctx.config.reviews.map((review) => review.path));
  const revIndex = input.rev ? ctx.config.revisions.findIndex((rev) => rev.id === input.rev) : -1;

  const docs: DocumentListEntry[] = [];
  for (const doc of workspace.documents) {
    const revisions: DocumentRevisionSummary[] = (doc.revisions ?? []).map((rev) => ({
      id: rev.id,
      label: rev.label,
      path: rev.path,
      changed: rev.changed,
      added: rev.stats.added,
      removed: rev.stats.removed,
      baseId: rev.baseId,
    }));

    let statusInRevision: DocumentListEntry["statusInRevision"];
    if (input.rev) {
      const addedIdx = doc.addedInRevision
        ? ctx.config.revisions.findIndex((rev) => rev.id === doc.addedInRevision)
        : -1;
      if (addedIdx > revIndex) {
        statusInRevision = "not_yet_added";
      } else if (doc.addedInRevision === input.rev) {
        statusInRevision = "added";
      } else {
        const active = doc.revisions?.find((rev) => rev.id === input.rev);
        statusInRevision = active ? (active.changed ? "modified" : "inherited") : "inherited";
      }
      if (input.changedOnly && statusInRevision !== "added" && statusInRevision !== "modified") {
        continue;
      }
    } else if (input.changedOnly && !revisions.some((rev) => rev.changed)) {
      continue;
    }

    docs.push({
      path: doc.path,
      title: doc.title,
      lineCount: doc.lineCount,
      isReview: reviewPaths.has(doc.path),
      addedInRevision: doc.addedInRevision,
      revisions,
      statusInRevision,
    });
  }

  return {
    projectTitle: ctx.config.title,
    configuredRevisions: ctx.config.revisions,
    documents: docs,
  };
}

export async function getDocument(
  ctx: McpContext,
  input: GetDocumentInput,
): Promise<GetDocumentResult> {
  const workspace = await loadWorkspace(ctx.config);
  const { doc, impliedRevId } = resolveDocumentTarget(workspace, input.path);
  const isReviewDoc = ctx.config.reviews.some((review) => review.path === doc.path);
  const effectiveRev =
    isReviewDoc && input.rev === undefined
      ? undefined
      : (input.rev ?? impliedRevId ?? doc.addedInRevision);

  const resolved = resolveSourceAtRevision(ctx.config, doc, effectiveRev);
  const lines = resolved.source.split("\n");
  const totalLines = lines.length;
  const startLine = input.startLine ?? 1;
  const endLine = input.endLine ?? totalLines;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new QueryError(`Invalid startLine ${startLine}: must be >= 1`);
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new QueryError(`Invalid endLine ${endLine}: must be >= startLine (${startLine})`);
  }
  if (startLine > totalLines) {
    throw new QueryError(`startLine ${startLine} exceeds document length (${totalLines} lines)`);
  }

  const clampedEnd = Math.min(endLine, totalLines);
  const width = String(clampedEnd).length;
  const withNumbers = input.withLineNumbers ?? true;
  const slice = lines.slice(startLine - 1, clampedEnd);
  const content = withNumbers
    ? slice
        .map((line, index) => `${String(startLine + index).padStart(width)} | ${line}`)
        .join("\n")
    : slice.join("\n");

  return {
    path: doc.path,
    title: doc.title,
    revision: {
      id: resolved.id,
      label: resolved.label,
      sourcePath: resolved.sourcePath,
      inherited: resolved.inherited,
      inheritedFrom: resolved.inheritedFrom,
    },
    totalLines,
    startLine,
    endLine: clampedEnd,
    content,
  };
}

export async function diffDocument(
  ctx: McpContext,
  input: DiffDocumentInput,
): Promise<DiffDocumentResult> {
  const workspace = await loadWorkspace(ctx.config);
  const { doc, impliedRevId } = resolveDocumentTarget(workspace, input.path);
  const targetRevId = input.rev || impliedRevId;
  if (!targetRevId) throw new QueryError("rev is required");
  const targetCfg = assertRevisionId(ctx.config, targetRevId);

  if (input.baseRev !== undefined) {
    if (input.baseRev === targetRevId) {
      const targetResolved = resolveSourceAtRevision(ctx.config, doc, targetRevId);
      return {
        path: doc.path,
        title: doc.title,
        base: {
          id: targetResolved.id,
          label: targetResolved.label,
          sourcePath: targetResolved.sourcePath,
        },
        target: {
          id: targetResolved.id,
          label: targetResolved.label,
          sourcePath: targetResolved.sourcePath,
        },
        changed: false,
        stats: { changed: false, added: 0, removed: 0 },
        unifiedDiff: "",
      };
    }

    const targetResolved = resolveSourceAtRevision(ctx.config, doc, targetRevId);
    let oldSource: string | undefined;
    let baseMeta: DiffDocumentResult["base"];
    if (input.baseRev === "baseline" && doc.addedInRevision) {
      oldSource = undefined;
      baseMeta = { id: "baseline", label: "基线" };
    } else {
      const baseResolved = resolveSourceAtRevision(ctx.config, doc, input.baseRev);
      oldSource = baseResolved.source;
      baseMeta = {
        id: baseResolved.id,
        label: baseResolved.label,
        sourcePath: baseResolved.sourcePath,
      };
    }

    const stats = diffStats(oldSource, targetResolved.source);
    const unifiedDiff = formatUnifiedDiff(oldSource, targetResolved.source, {
      oldLabel: baseMeta.sourcePath ?? "/dev/null",
      newLabel: targetResolved.sourcePath,
      contextLines: input.contextLines,
    });
    return {
      path: doc.path,
      title: doc.title,
      base: baseMeta,
      target: {
        id: targetResolved.id,
        label: targetResolved.label,
        sourcePath: targetResolved.sourcePath,
      },
      changed: stats.changed,
      stats,
      unifiedDiff,
    };
  }

  const revs = doc.revisions ?? [];
  const activeRev = revs.find((rev) => rev.id === targetRevId);
  if (!activeRev) {
    const resolved = resolveSourceAtRevision(ctx.config, doc, targetRevId);
    return {
      path: doc.path,
      title: doc.title,
      base: null,
      target: {
        id: targetCfg.id,
        label: targetCfg.label,
        sourcePath: resolved.sourcePath,
      },
      changed: false,
      stats: { changed: false, added: 0, removed: 0 },
      unifiedDiff: "",
      note: `该文档在修订版「${targetCfg.label}」中未修改（当前沿用 ${resolved.inheritedFrom ?? "基线"} 内容）。如需与其他版本对比，请传入 baseRev。`,
    };
  }

  const baseRev = activeRev.baseId ? revs.find((rev) => rev.id === activeRev.baseId) : undefined;
  const oldSource = baseRev
    ? baseRev.source
    : doc.addedInRevision === activeRev.id
      ? undefined
      : doc.source;
  const baseMeta: DiffDocumentResult["base"] = baseRev
    ? { id: baseRev.id, label: baseRev.label, sourcePath: baseRev.path }
    : doc.addedInRevision === activeRev.id
      ? null
      : { id: "baseline", label: "基线", sourcePath: doc.path };

  const unifiedDiff = formatUnifiedDiff(oldSource, activeRev.source, {
    oldLabel: baseMeta?.sourcePath ?? "/dev/null",
    newLabel: activeRev.path,
    contextLines: input.contextLines,
  });

  return {
    path: doc.path,
    title: doc.title,
    base: baseMeta,
    target: {
      id: activeRev.id,
      label: activeRev.label,
      sourcePath: activeRev.path,
    },
    changed: activeRev.changed,
    stats: { changed: activeRev.changed, ...activeRev.stats },
    unifiedDiff,
  };
}
