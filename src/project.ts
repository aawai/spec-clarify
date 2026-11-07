import { glob, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ADAPTERS, ADAPTER_NAMES, type ReviewParser } from "./review/adapters/index.js";
import type { Review } from "./review/model.js";

export const DEFAULT_CONFIG_FILE = "spec-clarify.config.json";

const ConfigFile = z
  .object({
    /** Site name shown in the header, page titles and the export. */
    title: z.string().trim().min(1).default("规格澄清"),
    /** Glob patterns, relative to the config file, of the documents the review refers to. */
    documents: z.array(z.string().min(1)).default([]),
    review: z
      .object({
        /** Review document, relative to the config file. */
        path: z.string().min(1),
        adapter: z.enum(ADAPTER_NAMES).default("markdown"),
        options: z.unknown().optional(),
      })
      .strict(),
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

export interface ProjectConfig {
  /** Directory containing the config file; every configured path is relative to it. */
  root: string;
  title: string;
  documentPatterns: string[];
  reviewPath: string;
  parseReview: ReviewParser;
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
  return {
    root,
    title: config.title,
    documentPatterns: config.documents,
    reviewPath: toPosix(config.review.path),
    parseReview: ADAPTERS[config.review.adapter](config.review.options),
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
  review: Review;
  /** Configured documents in path order, then the review document. */
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
 * Reads the documents and the review on every call, so edits to the sources show up without a
 * restart. Any failure is a `SourceError`: the site then refuses to show or record anything
 * rather than attaching records to a review it cannot read.
 */
export async function loadWorkspace(config: ProjectConfig): Promise<Workspace> {
  try {
    const paths = new Set<string>();
    for (const pattern of config.documentPatterns) {
      for await (const match of glob(pattern, { cwd: config.root })) {
        const path = toPosix(relative(config.root, resolve(config.root, match)));
        if (path.startsWith("../")) throw new Error(`Document ${match} lies outside the project`);
        paths.add(path);
      }
    }
    paths.delete(config.reviewPath);
    const documents = await Promise.all(
      [...paths].sort().map((path) => readDocument(config.root, path)),
    );
    const reviewDocument = await readDocument(config.root, config.reviewPath);
    documents.push(reviewDocument);

    let review: Review;
    try {
      review = config.parseReview(reviewDocument.source);
    } catch (error) {
      throw new Error(`${config.reviewPath}: ${error instanceof Error ? error.message : error}`, {
        cause: error,
      });
    }

    const byPath = new Map(documents.map((doc) => [doc.path, doc]));
    const byName = new Map<string, SourceDocument[]>();
    for (const doc of documents) {
      const name = basename(doc.path);
      byName.set(name, [...(byName.get(name) ?? []), doc]);
    }
    return {
      review,
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
