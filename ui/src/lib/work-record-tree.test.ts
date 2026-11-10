import { describe, expect, it } from "vitest";
import { buildWorkRecordTreeRows } from "./work-record-tree";

type Item = { id: string; parentRecordId: string | null; title: string };
const compare = (left: Item, right: Item) => left.title.localeCompare(right.title);

function rows(records: Item[], directMatchIds = new Set(records.map((record) => record.id)), collapsedIds = new Set<string>(), compareRows: (left: Item, right: Item) => number = () => 0) {
  return buildWorkRecordTreeRows({ records, directMatchIds, collapsedIds, compare: compareRows });
}

describe("buildWorkRecordTreeRows", () => {
  const records: Item[] = [
    { id: "root", parentRecordId: null, title: "工作包" },
    { id: "dev", parentRecordId: "root", title: "程序" },
    { id: "qa", parentRecordId: "dev", title: "QA" },
    { id: "design", parentRecordId: "root", title: "策划" },
  ];

  it("renders a stable multi-level WBS without duplicating parents", () => {
    expect(rows(records).map((row) => [row.record.id, row.depth])).toEqual([
      ["root", 0], ["dev", 1], ["qa", 2], ["design", 1],
    ]);
  });

  it("sorts siblings without flattening the hierarchy", () => {
    const sorted = rows([
      { id: "root-z", parentRecordId: null, title: "Z 根" },
      { id: "child-a", parentRecordId: "root-z", title: "A 子" },
      { id: "root-a", parentRecordId: null, title: "A 根" },
      { id: "child-z", parentRecordId: "root-z", title: "Z 子" },
    ], undefined, undefined, compare);
    expect(sorted.map((row) => row.record.id)).toEqual(["root-a", "root-z", "child-a", "child-z"]);
  });

  it("collapses descendants without changing the source records", () => {
    expect(rows(records, new Set(records.map((record) => record.id)), new Set(["dev"])).map((row) => row.record.id)).toEqual([
      "root", "dev", "design",
    ]);
    expect(records).toHaveLength(4);
  });

  it("adds filtered ancestors as non-selectable context and ignores collapsed state", () => {
    const result = rows(records, new Set(["qa"]), new Set(["root", "dev"]));
    expect(result.map((row) => [row.record.id, row.contextOnly])).toEqual([
      ["root", true], ["dev", true], ["qa", false],
    ]);
  });

  it("keeps orphans visible and breaks legacy cycles deterministically", () => {
    const cyclic: Item[] = [
      { id: "a", parentRecordId: "b", title: "A" },
      { id: "b", parentRecordId: "a", title: "B" },
      { id: "orphan", parentRecordId: "missing", title: "C" },
    ];
    const result = rows(cyclic);
    expect(result.map((row) => row.record.id)).toEqual(["a", "b", "orphan"]);
    expect(result.find((row) => row.record.id === "a")?.relationWarning).toBe("cycle");
    expect(result.find((row) => row.record.id === "orphan")?.relationWarning).toBe("missing_parent");
  });

  it("does not mutate the source array", () => {
    const source = records.map((record) => Object.freeze({ ...record }));
    const order = source.map((record) => record.id);
    rows(source);
    expect(source.map((record) => record.id)).toEqual(order);
  });
});
