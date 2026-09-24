# ADR 索引

按时间顺序记录本仓库的**架构决策**。新决策追加编号，勿删旧 ADR；变更时写新 ADR 并标记 supersede。

模板见同目录 [`_template.md`](_template.md)。

| ADR | 标题 | 状态 |
|-----|------|------|
| [001](001-rendering-pixi-live2d-display-advanced.md) | Live2D 渲染选型：pixi-live2d-display-advanced | Superseded by ADR-003 |
| [002](002-pet-mount-and-state-source.md) | 宠物挂载点与状态事件源 | Accepted |
| [003](003-spike-results-and-rendering-stack.md) | 渲染栈落地与 spike 验证结果 | Accepted |
| [004](004-plugin-packaging-and-communication.md) | 插件打包形态与通信架构（DSH 实证调研） | Proposed |
| [005](005-pet-visual-top-layer-popover.md) | 宠物视觉层挂载：Popover API（浏览器顶层），回退 body portal | Accepted |
| [006](006-push-state-sse.md) | Host→Client 状态传输：SSE 推送替代轮询（supersede ADR-004 通信条款） | Accepted |
| [007](007-personas-plugin-owned-jsonc-file.md) | 自定义人设走插件独有 JSONC 文件（不进 DSH settings 体系） | Accepted |
| [008](008-motion-priority-and-focus-suppression.md) | Live2D 动作优先级与 focus 抑制规则 | Accepted |
| [009](009-custom-model-animation-mapping.md) | 自定义模型动画映射与 debug 动画预览 | Accepted |
| [010](010-local-model-host-route.md) | 本地模型通过 Host 路由加载 | Accepted |
| [011](011-dsh-0.1.5-rc.1-adaptation.md) | 适配 DSH 0.1.5-rc.1（client-runtime 移除、settings namespace 字符串化、依赖策略对齐官方） | Accepted |
