import { z } from "zod";
import {
  buildReview,
  isDelimiterRow,
  splitTableRow,
  type ItemDraft,
  type Review,
  type ReviewGroup,
} from "../model.js";

/**
 * Adapter for the Chinese "PRD 审核报告" layout:
 *
 * - `## 2. …` to `## 5. …`: cross-module sections. Sections 2, 3 and 5 are tables with an `ID` or
 *   `#` column; section 4 consists of `### G<n> 标题` prose blocks.
 * - `### A.<n> <file>.md` opens a module; its `####` subsections 问题清单 (table with `ID`),
 *   图中独有的规则 and 图文冲突 (tables with a `#` column) and 需产品决策的问题 (numbered list)
 *   become groups. Items of the last three are numbered `<prefix>-F<#>`, `<prefix>-X<#>` and
 *   `<prefix>-Q<n>`, where the prefix comes from the `modules` option.
 */
export const prdReviewOptions = z
  .object({
    /** Module file → ID prefix, e.g. `{ "login.md": "L" }`. */
    modules: z.record(z.string().regex(/\.md$/), z.string().regex(/^[A-Z]+$/)),
  })
  .strict();

type Kind =
  | "contradiction"
  | "risk"
  | "shared-rule"
  | "parameter"
  | "issue"
  | "figure-rule"
  | "figure-conflict"
  | "question";

const SECTIONS: Record<string, { kind: Kind; title: string }> = {
  "2": { kind: "contradiction", title: "2. 直接矛盾" },
  "3": { kind: "risk", title: "3. 安全与数据完整性风险" },
  "4": { kind: "shared-rule", title: "4. 未定义的共享规则" },
  "5": { kind: "parameter", title: "5. 工程默认参数" },
};

const SUBSECTIONS: Record<string, Kind> = {
  问题清单: "issue",
  图中独有的规则: "figure-rule",
  图文冲突: "figure-conflict",
  需产品决策的问题: "question",
};

/** Column holding the item title for each table-backed kind. */
const TITLE_COLUMN: Partial<Record<Kind, string>> = {
  contradiction: "矛盾",
  risk: "风险",
  parameter: "参数",
  issue: "问题",
  "figure-rule": "规则",
  "figure-conflict": "冲突",
};

/** Kinds whose rows carry only a per-module number; the ID gets the module prefix and this letter. */
const MODULE_NUMBERED: Partial<Record<Kind, string>> = {
  "figure-rule": "F",
  "figure-conflict": "X",
  question: "Q",
};

interface Group extends ReviewGroup {
  kind: Kind;
}

export function parsePrdReview(source: string, options: z.infer<typeof prdReviewOptions>): Review {
  const lines = source.split("\n");
  const groups: Group[] = [];
  const drafts: ItemDraft[] = [];

  let group: Group | undefined;
  let moduleFile: string | undefined;
  let header: string[] | undefined;
  let prose: { id: string; title: string; start: number } | undefined;

  const openGroup = (next: Group | undefined) => {
    group = next;
    header = undefined;
    if (next) groups.push(next);
  };

  const closeProse = (endIndex: number) => {
    if (!prose || !group) return;
    let end = endIndex;
    while (end > prose.start + 1 && !lines[end - 1]?.trim()) end--;
    drafts.push({
      id: prose.id,
      group,
      title: prose.title,
      fields: [],
      body: lines
        .slice(prose.start + 1, end)
        .join("\n")
        .trim(),
      relatedText: [],
      line: prose.start + 1,
      endLine: end,
    });
    prose = undefined;
  };

  const moduleId = (kind: Kind, number: string, line: number) => {
    const letter = MODULE_NUMBERED[kind];
    const prefix = moduleFile ? options.modules[moduleFile] : undefined;
    if (!letter || !prefix) throw new Error(`Cannot number ${kind} items at line ${line}`);
    if (!/^\d+$/.test(number)) {
      throw new Error(`Line ${line}: the # column must be a number, got "${number}"`);
    }
    return `${prefix}-${letter}${number}`;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const heading = /^(#{2,4}) (.+)$/.exec(line);

    if (heading || line.trim() === "---") closeProse(index);

    if (heading) {
      const level = heading[1]?.length;
      const text = heading[2]?.trim() ?? "";
      if (level === 2) {
        moduleFile = undefined;
        const section = SECTIONS[/^(\d)\. /.exec(text)?.[1] ?? ""];
        openGroup(
          section
            ? {
                key: section.kind,
                title: section.title,
                label: section.title,
                section: "跨模块",
                kind: section.kind,
              }
            : undefined,
        );
        continue;
      }
      if (level === 3) {
        const module = /^A\.\d+ (\S+\.md)$/.exec(text)?.[1];
        if (module) {
          if (!options.modules[module]) {
            throw new Error(
              `Line ${index + 1}: module ${module} has no ID prefix in the adapter's "modules" option`,
            );
          }
          moduleFile = module;
          openGroup(undefined);
          continue;
        }
        const sharedRule = /^(G\d+) (.+)$/.exec(text);
        if (group?.kind === "shared-rule" && sharedRule?.[1] && sharedRule[2]) {
          prose = { id: sharedRule[1], title: sharedRule[2], start: index };
        }
        continue;
      }
      const kind = SUBSECTIONS[text];
      openGroup(
        kind && moduleFile
          ? {
              key: `${moduleFile}/${kind}`,
              title: `${moduleFile} · ${text}`,
              label: text,
              section: moduleFile,
              defaultDocument: moduleFile,
              kind,
            }
          : undefined,
      );
      continue;
    }

    if (!group) continue;

    if (group.kind === "question") {
      const question = /^(\d+)\. (.+)$/.exec(line);
      if (!question?.[1] || !question[2]) continue;
      drafts.push({
        id: moduleId("question", question[1], index + 1),
        group,
        title: question[2],
        fields: [],
        relatedText: [question[2]],
        line: index + 1,
        endLine: index + 1,
      });
      continue;
    }

    if (!line.startsWith("|")) {
      header = undefined;
      continue;
    }
    const cells = splitTableRow(line);
    const titleColumn = TITLE_COLUMN[group.kind];
    if (!titleColumn) throw new Error(`Line ${index + 1}: ${group.title} does not contain tables`);
    if (!header) {
      // A renamed column would otherwise silently turn every row into an untitled item.
      if (!cells.includes(titleColumn)) {
        throw new Error(
          `Line ${index + 1}: table in ${group.title} lacks the ${titleColumn} column`,
        );
      }
      const idColumn = MODULE_NUMBERED[group.kind] ? "#" : undefined;
      if (idColumn && !cells.includes(idColumn)) {
        throw new Error(`Line ${index + 1}: table in ${group.title} lacks the # column`);
      }
      if (!idColumn && !cells.includes("ID") && !cells.includes("#")) {
        throw new Error(`Line ${index + 1}: table in ${group.title} lacks an ID or # column`);
      }
      header = cells;
      continue;
    }
    if (isDelimiterRow(cells)) continue;

    const row = new Map(header.map((label, column) => [label, cells[column] ?? ""]));
    const id = MODULE_NUMBERED[group.kind]
      ? moduleId(group.kind, row.get("#") ?? "", index + 1)
      : (row.get("ID") ?? row.get("#") ?? "");
    if (!id) throw new Error(`Line ${index + 1}: row has no ID`);
    const title = row.get(titleColumn) ?? "";
    drafts.push({
      id,
      group,
      title,
      severity: row.get("严重度") || undefined,
      fields: header
        .filter((label) => label !== "ID" && label !== "#" && label !== titleColumn)
        .map((label) => ({ label, value: row.get(label) ?? "" })),
      relatedText: [
        row.get("相关条目") ?? "",
        ...[...title.matchAll(/（([^（）]*)）/g)].map((match) => match[1] ?? ""),
      ],
      line: index + 1,
      endLine: index + 1,
    });
  }
  closeProse(lines.length);

  return buildReview(groups, drafts);
}
