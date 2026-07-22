/**
 * Paper metadata domain: catalog row type, paper-folder detection + asset
 * predicates, blob viewer-source / catalog loading (side effects), and
 * file-tree label/sort policy. Split across submodules; this facade preserves
 * the `@/lib/paper-metadata` import surface.
 */

export * from "@/lib/paper-metadata/assets";
export * from "@/lib/paper-metadata/detect";
export * from "@/lib/paper-metadata/label";
export * from "@/lib/paper-metadata/types";
