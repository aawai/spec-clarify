import { z } from "zod";
import type { ParsedReview } from "../model.js";
import { markdownOptions, parseMarkdownReview } from "./markdown.js";
import { parsePrdReview, prdReviewOptions } from "./prd-review.js";

/** Parses one review document; `path` is its project-relative path. */
export type ReviewParser = (source: string, path: string) => ParsedReview;

function adapter<S extends z.ZodType>(
  options: S,
  parse: (source: string, path: string, options: z.infer<S>) => ParsedReview,
) {
  return (raw: unknown): ReviewParser => {
    const parsed = options.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid adapter options: ${z.prettifyError(parsed.error)}`);
    }
    return (source, path) => parse(source, path, parsed.data);
  };
}

export const ADAPTERS = {
  markdown: adapter(markdownOptions, (source, path) => parseMarkdownReview(source, path)),
  "prd-review": adapter(prdReviewOptions, parsePrdReview),
};

export type AdapterName = keyof typeof ADAPTERS;
export const ADAPTER_NAMES = Object.keys(ADAPTERS) as [AdapterName, ...AdapterName[]];
