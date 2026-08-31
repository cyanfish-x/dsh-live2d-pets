# ADR-010: 本地模型通过 Host 路由加载

## Status

Accepted

## Date

2026-08-16

## Context

README 声称支持“本机可达的本地模型地址”，但浏览器不能直接加载 `file://` 本地文件。用户希望直接填写本机硬盘绝对路径（如 `C:/models/foo/foo.model3.json`）来使用本地模型。

## Decision

采用 Host 路由方案，不建 junction：

- 用户自定义模型可填远程 URL 或**本地绝对路径**；
- 本地路径原样保存在 `custom-models.jsonc` 的 `modelUrl`；
- Host 根据自定义模型 id 将本地路径映射为同源虚拟 URL：

  ```text
  /pet-local-models/<customId>/<model3.json 文件名>
  ```

- 新增 `PET_LOCAL_MODELS_PREFIX = '/pet-local-models'` 前缀路由：
  - 按 `customId` 查找自定义模型；
  - 解析本地目录；
  - 安全校验相对路径，拒绝路径穿越；
  - 读取文件并返回给浏览器；
- `resolveModelUrl()` 对本地路径返回上述虚拟 URL，客户端照常通过同源 HTTP 加载。

### 「选择本地文件」按钮（v0.2.3，v0.2.4 改为自研目录浏览）

设置页 URL 框右侧新增「选择本地文件」按钮，回填本地模型的**文件绝对路径**：

- **不依赖 DSH 的 `directoryPicker` 服务**（该服务须另行加载 `dsh-host-directory-picker-*` 后端插件；未加载时访问 `ctx.directoryPicker` 会抛 `cannot get property "directoryPicker" without inject`，导致整个插件加载失败）。改为插件自研：Host 侧直接用 Node `fs` 扫描目录，客户端逐级导航。
  - 新增 Host 端点 `POST /api/live2d-pet/list-local-dir`：入参 `{ path? }`，返回 `{ ok, listing }`，`listing` 含当前路径、家目录、上级、子目录列表、以及当前目录下的 `.model3.json` 文件列表（`listLocalDir()`，安全 stat + 排序 + 跳过损坏条目）；
  - 客户端设置页弹层（`LocalFileBrowser`）：点「🏠 家目录」/「⬆ 上级」/子目录逐级进入，点 `.model3.json` 文件即回填其绝对路径到 URL 框；
- 回填的是 `.model3.json` **文件**绝对路径（满足“选文件”预期），仍走既有 `/pet-local-models/...` 路由加载；
- 用户仍可手填本地绝对路径，并支持 Unix 家目录简写 `~/...`（`localModelTarget`/`expandLocalPath` 先行展开）。
- 所有 `POST /api/live2d-pet/*` 必须带 `Content-Type: application/json`（无参 POST 用 `body: '{}'`），否则被 dsh-host-apiproxy 在分发前以 415 拒绝。

## Alternatives Considered

### 备选方案 A：junction 链接到静态资源目录

- Pros：固定路径可见。
- Cons：依赖 Windows junction / 跨平台复杂；升级易丢；清理成本高。
- Rejected：Host 路由更简单、跨平台、不修改用户文件系统。

### 备选方案 B：让用户自己起本地 HTTP 服务

- Pros：实现零成本。
- Cons：用户负担大，体验差。
- Rejected：插件应直接支持本地路径。

## Consequences

- 用户可直接填写本地绝对路径加载模型；
- 浏览器始终只访问同源 HTTP URL，不暴露 `file://`；
- 需要处理本地路径失效时的加载失败提示；
- 本地模型资源（贴图、动作、物理）随模型目录相对路径一并可访问。
