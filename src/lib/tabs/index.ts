/**
 * Center document-tab model. Split into: model.ts (DocTab type + pure tab-list
 * reducers), resolve.ts (async path→tab resource loading + blob sources +
 * background-task triggers), and persist.ts (per-window localStorage). This
 * facade preserves the `@/lib/tabs` import surface.
 */

export * from "@/lib/tabs/model";
export * from "@/lib/tabs/persist";
export * from "@/lib/tabs/resolve";
