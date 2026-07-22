/**
 * Agent subsystem client. Split into: types.ts (ACP/catalog/event payload
 * types), catalog.ts (registry scan/probe/enable/proxy), session.ts
 * (run/list/load/cancel/permission/warm), events.ts (`agent:*` subscribers),
 * and prefs.ts (per-agent model pref/favorites/catalog in localStorage). This
 * facade preserves the `@/lib/agent` import surface.
 */

export * from "@/lib/agent/catalog";
export * from "@/lib/agent/events";
export * from "@/lib/agent/prefs";
export * from "@/lib/agent/session";
export * from "@/lib/agent/types";
