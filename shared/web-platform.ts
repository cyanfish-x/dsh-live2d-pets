/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/**
 * The module specifiers the shell shares into the frozen module table.
 * Mirrors the shipped dsh 0.1.5-rc.1 web app seed table（实测 dist boot 载荷）：
 * - `dsh-client-runtime`（0.1.0 时代条目）已随包移除；
 * - `dsh-client-web-react` / `dsh-client-schema-form` 不再进表；
 * - 新增 `dsh-client-store` 与 `dsh-client-ui-dockkit`；
 * - `dsh-client-ui-slots` 仍在表（纯核心保持独立模块身份）。
 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
