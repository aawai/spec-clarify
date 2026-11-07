import { glob, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ADAPTERS, ADAPTER_NAMES, type ReviewParser } from "./review/adapters/index.js";
import { buildReview, type ParsedReview, type Review } from "./review/model.js";

export const DEFAULT_CONFIG_FILE = "spec-clarify.config.json";

const ConfigFile = z
  .object({
    /** Site name shown in the header, page titles and the export. */
    title: z.string().trim().min(1).default("规格澄清"),
    /** Glob patterns, relative to the config file, of the documents the reviews refer to. */
    documents: z.array(z.string().min(1)).default([]),
    /** Review documents clarified on this site; item IDs must be unique across all of them. */
    reviews: z
      .array(
        z
          .object({
            /** Review document, relative to the config file. */
            path: z.string().min(1),
            /** Name in the navigation and the export; defaults to the document's `#` heading. */
            title: z.string().trim().min(1).optional(),
            adapter: z.enum(ADAPTER_NAMES).default("markdown"),
            options: z.unknown().optional(),
          })
          .strict(),
      )
      .min(1),
    /** Severity scale from most to least severe; determines chip colours and filter order. */
    severities: z.array(z.string().trim().min(1)).default([]),
    /** SQLite database, relative to the config file. One database holds one project. */
    database: z.string().min(1).default("data/spec-clarify.db"),
    /** Render raw HTML inside documents. Only enable for documents you control. */
    trustDocumentHtml: z.boolean().default(false),
    /** Let documents load images from other origins (otherwise only same-origin and data: URLs). */
    allowExternalImages: z.boolean().default(false),
  })
  .strict();

export interface ReviewSource {
  /** Project-relative path with `/` separators. */
  path: string;
  title?: string;
  parse: ReviewParser;
}

export interface ProjectConfig {
  /** Directory containing the config file; every configured path is relative to it. */
  root: string;
  title: string;
  documentPatterns: string[];
  reviews: ReviewSource[];
  severities: string[];
  databasePath: string;
  trustDocumentHtml: boolean;
  allowExternalImages: boolean;
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const file = resolve(configPath);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read config ${file}: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      },
    );
  }
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid config ${file}:\n${z.prettifyError(parsed.error)}`);
  const config = parsed.data;
  const root = dirname(file);
  const reviews = config.reviews.map((review): ReviewSource => ({
    path: toPosix(relative(root, resolve(root, review.path))),
    title: review.title,
    parse: ADAPTERS[review.adapter](review.options),
  }));
  const paths = new Set<string>();
  for (const review of reviews) {
    if (review.path.startsWith("../")) {
      throw new Error(`Invalid config ${file}: review ${review.path} lies outside the project`);
    }
    if (paths.has(review.path)) {
      throw new Error(`Invalid config ${file}: review ${review.path} is listed twice`);
    }
    paths.add(review.path);
  }
  return {
    root,
    title: config.title,
    documentPatterns: config.documents,
    reviews,
    severities: config.severities,
    databasePath: isAbsolute(config.database) ? config.database : resolve(root, config.database),
    trustDocumentHtml: config.trustDocumentHtml,
    allowExternalImages: config.allowExternalImages,
  };
}

/** A configured document or review source that cannot be read or parsed. */
export class SourceError extends Error {}

export interface SourceDocument {
  /** Path relative to the project root, with `/` separators; used in URLs. */
  path: string;
  title: string;
  source: string;
  lineCount: number;
}

export interface Workspace {
  /** Items of every review document, in configuration order. */
  review: Review;
  /** The review documents, in configuration order; `title` honours the configured title. */
  reviews: SourceDocument[];
  /** Configured documents in path order, then the review documents. */
  documents: SourceDocument[];
  /**
   * Resolves a reference such as `login.md` or `specs/login.md`: an exact relative path first,
   * then a file name that is unique among the documents.
   */
  resolve(name: string): SourceDocument | undefined;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function readDocument(root: string, path: string): Promise<SourceDocument> {
  const source = await readFile(resolve(root, path), "utf8");
  return {
    path,
    title: /^# (.+)$/m.exec(source)?.[1]?.trim() ?? basename(path),
    source,
    lineCount: source.split("\n").length,
  };
}

/**
 * With several review documents, groups are shown under their document's title so that groups of
 * the same name stay apart; with one document the document level is left out.
 */
function placeGroups(parsed: ParsedReview, reviewTitle: string, multiple: boolean) {
  for (const group of parsed.groups) {
    if (!multiple) {
      group.section ||= "分组";
      continue;
    }
    group.section = group.section ? `${reviewTitle} · ${group.section}` : reviewTitle;
    group.title = `${reviewTitle} · ${group.title}`;
  }
}

/**
 * Reads the documents and the reviews on every call, so edits to the sources show up without a
 * restart. Any failure is a `SourceError`: the site then refuses to show or record anything
 * rather than attaching records to reviews it cannot read.
 */
export async function loadWorkspace(config: ProjectConfig): Promise<Workspace> {
  try {
    const reviewPaths = new Set(config.reviews.map((review) => review.path));
    const paths = new Set<string>();
    for (const pattern of config.documentPatterns) {
      for await (const match of glob(pattern, { cwd: config.root })) {
        const path = toPosix(relative(config.root, resolve(config.root, match)));
        if (path.startsWith("../")) throw new Error(`Document ${match} lies outside the project`);
        if (!reviewPaths.has(path)) paths.add(path);
      }
    }
    const documents = await Promise.all(
      [...paths].sort().map((path) => readDocument(config.root, path)),
    );
    const reviews = await Promise.all(
      config.reviews.map(async (source) => {
        const doc = await readDocument(config.root, source.path);
        return { source, doc: { ...doc, title: source.title ?? doc.title } };
      }),
    );
    documents.push(...reviews.map(({ doc }) => doc));

    const parsed = reviews.map(({ source, doc }) => {
      try {
        const result = source.parse(doc.source, doc.path);
        placeGroups(result, doc.title, reviews.length > 1);
        return result;
      } catch (error) {
        throw new Error(`${doc.path}: ${error instanceof Error ? error.message : error}`, {
          cause: error,
        });
      }
    });
    const review = buildReview(parsed);

    const byPath = new Map(documents.map((doc) => [doc.path, doc]));
    const byName = new Map<string, SourceDocument[]>();
    for (const doc of documents) {
      const name = basename(doc.path);
      byName.set(name, [...(byName.get(name) ?? []), doc]);
    }
    return {
      review,
      reviews: reviews.map(({ doc }) => doc),
      documents,
      resolve: (name) => {
        const exact = byPath.get(name);
        if (exact) return exact;
        const candidates = byName.get(name);
        return candidates?.length === 1 ? candidates[0] : undefined;
      },
    };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
