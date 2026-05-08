import type { List, ListItem, Root } from "mdast";
import type { Parent } from "unist";

const isTaskListItem = (item: ListItem): boolean => typeof item.checked === "boolean";

const splitMixedList = (list: List): List[] => {
  const hasTaskItem = list.children.some(isTaskListItem);
  const hasRegularItem = list.children.some((item) => !isTaskListItem(item));

  if (!hasTaskItem || !hasRegularItem) {
    return [list];
  }

  const groups: Array<{ isTaskGroup: boolean; items: ListItem[] }> = [];
  for (const item of list.children) {
    const isTaskGroup = isTaskListItem(item);
    const previousGroup = groups.at(-1);

    if (previousGroup && previousGroup.isTaskGroup === isTaskGroup) {
      previousGroup.items.push(item);
    } else {
      groups.push({ isTaskGroup, items: [item] });
    }
  }

  return groups.map(({ isTaskGroup, items }) => ({
    ...list,
    children: isTaskGroup ? items : items.map((item) => ({ ...item, spread: false })),
    spread: isTaskGroup ? list.spread : false,
  }));
};

const splitMixedTaskListsInParent = (parent: Parent): void => {
  for (let index = 0; index < parent.children.length; index++) {
    const child = parent.children[index];

    if ("children" in child && Array.isArray(child.children)) {
      splitMixedTaskListsInParent(child as Parent);
    }

    if (child.type !== "list") {
      continue;
    }

    const splitLists = splitMixedList(child as List);
    if (splitLists.length > 1) {
      parent.children.splice(index, 1, ...splitLists);
      index += splitLists.length - 1;
    }
  }
};

export const remarkSplitMixedTaskLists = () => {
  return (tree: Root) => {
    splitMixedTaskListsInParent(tree);
  };
};
