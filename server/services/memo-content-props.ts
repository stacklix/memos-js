/**
 * Derive memo `property` and filter flags from raw markdown content.
 * Title extraction matches golang `internal/markdown` (first block-level H1 only).
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

const CODE_FENCE = /```[\s\S]*?```/;

const MD_LINK = /\[[^\]]*]\([^)]+\)/;

const TASK_LINE = /(^|\n)[ \t]*[-*+][ \t]+\[[ xX]\]/;

const UNCHECKED_TASK = /(^|\n)[ \t]*[-*+][ \t]+\[[ \t]*\]/;

export function contentHasCode(content: string): boolean {
  return CODE_FENCE.test(content);
}

export function contentHasLink(content: string): boolean {
  return /https?:\/\//i.test(content) || MD_LINK.test(content);
}

export function contentHasTaskList(content: string): boolean {
  return TASK_LINE.test(content);
}

export function contentHasIncompleteTasks(content: string): boolean {
  return UNCHECKED_TASK.test(content);
}

/**
 * Title from the first block-level H1 in markdown (plain text, no inline formatting).
 * Matches golang `ExtractProperties` / `ExtractAll` (not h2+, not later headings, no fallback).
 */
export function extractTitleHint(content: string): string {
  let tree;
  try {
    tree = fromMarkdown(content);
  } catch {
    return "";
  }
  const first = tree.children[0];
  if (!first || first.type !== "heading" || first.depth !== 1) {
    return "";
  }
  return toString(first).trim();
}

export function deriveMemoProperty(content: string) {
  const hasCode = contentHasCode(content);
  const hasLink = contentHasLink(content);
  const hasTaskList = contentHasTaskList(content);
  const hasIncompleteTasks = contentHasIncompleteTasks(content);
  return {
    hasLink,
    hasTaskList,
    hasCode,
    hasIncompleteTasks,
    title: extractTitleHint(content),
  };
}
