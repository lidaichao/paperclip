export type WorkRecordTreeSource = {
  id: string;
  parentRecordId: string | null;
};

export type WorkRecordTreeRow<T extends WorkRecordTreeSource> = {
  record: T;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  contextOnly: boolean;
  relationWarning: "missing_parent" | "cycle" | null;
};

export function buildWorkRecordTreeRows<T extends WorkRecordTreeSource>({
  records,
  directMatchIds,
  collapsedIds,
  compare,
}: {
  records: T[];
  directMatchIds: Set<string>;
  collapsedIds: Set<string>;
  compare: (left: T, right: T) => number;
}): WorkRecordTreeRow<T>[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const sourceIndex = new Map(records.map((record, index) => [record.id, index]));
  const effectiveParent = new Map<string, string | null>();
  const relationWarnings = new Map<string, WorkRecordTreeRow<T>["relationWarning"]>();
  for (const record of records) {
    const missingParent = Boolean(record.parentRecordId && !byId.has(record.parentRecordId));
    const selfCycle = record.parentRecordId === record.id;
    effectiveParent.set(
      record.id,
      record.parentRecordId && record.parentRecordId !== record.id && byId.has(record.parentRecordId)
        ? record.parentRecordId
        : null,
    );
    relationWarnings.set(record.id, selfCycle ? "cycle" : missingParent ? "missing_parent" : null);
  }

  // Corrupt legacy data must not duplicate or hide rows. Break each cycle at
  // its earliest source row and keep the remaining links as a readable tree.
  const finalized = new Set<string>();
  for (const record of records) {
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | null = record.id;
    while (current && !finalized.has(current)) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const root = [...cycle].sort(
          (left, right) => (sourceIndex.get(left) ?? 0) - (sourceIndex.get(right) ?? 0),
        )[0];
        if (root) {
          effectiveParent.set(root, null);
          relationWarnings.set(root, "cycle");
        }
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = effectiveParent.get(current) ?? null;
    }
    for (const id of path) finalized.add(id);
  }

  const stableCompare = (left: T, right: T) => {
    const compared = compare(left, right);
    return compared || (sourceIndex.get(left.id) ?? 0) - (sourceIndex.get(right.id) ?? 0);
  };
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const record of records) {
    const parentId = effectiveParent.get(record.id);
    if (!parentId) roots.push(record);
    else children.set(parentId, [...(children.get(parentId) ?? []), record]);
  }
  roots.sort(stableCompare);
  for (const siblings of children.values()) siblings.sort(stableCompare);

  const filtering = directMatchIds.size !== records.length;
  const visibleIds = new Set(directMatchIds);
  if (filtering) {
    for (const id of directMatchIds) {
      const visited = new Set<string>();
      let parentId = effectiveParent.get(id) ?? null;
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        visibleIds.add(parentId);
        parentId = effectiveParent.get(parentId) ?? null;
      }
    }
  }

  const result: WorkRecordTreeRow<T>[] = [];
  const append = (record: T, depth: number) => {
    if (!visibleIds.has(record.id)) return;
    const recordChildren = children.get(record.id) ?? [];
    const visibleChildren = recordChildren.filter((child) => visibleIds.has(child.id));
    const expanded = filtering || !collapsedIds.has(record.id);
    result.push({
      record,
      depth,
      hasChildren: visibleChildren.length > 0,
      expanded,
      contextOnly: filtering && !directMatchIds.has(record.id),
      relationWarning: relationWarnings.get(record.id) ?? null,
    });
    if (expanded) for (const child of visibleChildren) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  return result;
}
