import { z } from "zod";
import type { Review } from "../model.js";
import { markdownOptions, parseMarkdownReview } from "./markdown.js";
import { parsePrdReview, prdReviewOptions } from "./prd-review.js";

export type ReviewParser = (source: string) => Review;

function adapter<S extends z.ZodType>(
  options: S,
  parse: (source: string, options: z.infer<S>) => Review,
) {
  return (raw: unknown): ReviewParser => {
    const parsed = options.safeParse(raw ?? {});
    if (!parsed.success)
      throw new Error(`Invalid adapter options: ${z.prettifyError(parsed.error)}`);
    return (source) => parse(source, parsed.data);
  };
}

export const ADAPTERS = {
  markdown: adapter(markdownOptions, (source) => parseMarkdownReview(source)),
  "prd-review": adapter(prdReviewOptions, parsePrdReview),
};

export type AdapterName = keyof typeof ADAPTERS;
export const ADAPTER_NAMES = Object.keys(ADAPTERS) as [AdapterName, ...AdapterName[]];
