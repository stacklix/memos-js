import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { List, ListItem } from "@/components/MemoContent/markdown";
import { TASK_LIST_CLASS, TASK_LIST_ITEM_CLASS } from "@/components/MemoContent/constants";
import { remarkSplitMixedTaskLists } from "@/utils/remark-plugins/remark-split-mixed-task-lists";
import { describe, expect, it } from "vitest";

const renderListContent = (content: string): string =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkSplitMixedTaskLists]}
      components={{
        ul: ({ children, ...props }) => <List {...props}>{children}</List>,
        li: ({ children, ...props }) => <ListItem {...props}>{children}</ListItem>,
      }}
    >
      {content}
    </ReactMarkdown>,
  );

describe("memo content lists", () => {
  it("keeps bullets on regular items in mixed task and bullet lists", () => {
    const html = renderListContent("- [ ] pickup package\n- [ ] library returns\n\n- milk\n- eggs\n- bread");
    const listOpenTags = html.match(/<ul class="[^"]*"/g) ?? [];

    expect(listOpenTags).toHaveLength(2);
    expect(listOpenTags[0]).toContain(TASK_LIST_CLASS);
    expect(listOpenTags[0]).toContain("list-none");
    expect(listOpenTags[0]).not.toContain("pl-6");
    expect(listOpenTags[1]).not.toContain(TASK_LIST_CLASS);
    expect(listOpenTags[1]).toContain("pl-6");
    expect(listOpenTags[1]).toContain("list-disc");
    expect(html).toContain('<li class="mt-0.5 leading-6">milk</li>');
    expect(html).not.toContain('<li class="mt-0.5 leading-6">\n<p>milk</p>');
    expect(html).toContain(TASK_LIST_ITEM_CLASS);
  });

  it("keeps compact styling for pure task lists", () => {
    const html = renderListContent("- [ ] pickup package\n- [ ] library returns");

    expect(html).toMatch(/<ul class="[^"]*\blist-none\b[^"]*"/);
    expect(html).not.toMatch(/<ul class="[^"]*\blist-disc\b[^"]*"/);
  });
});
