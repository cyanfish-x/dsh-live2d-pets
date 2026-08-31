# Spec: Live2D 宠物插件 v0.1

用户可感知行为规格。对应 Intent：[`../intent/live2d-pet-plugin.md`](../intent/live2d-pet-plugin.md)。
状态事件与挂载点基于实测（ADR-002）；渲染技术基于 ADR-001。

## 1. 概述

DSH Web GUI 中一只悬浮于角落的 Live2D 桌宠，实时镜像当前会话 agent 状态（思考/空闲/出错/完成），支持分部位触摸互动、任务完成庆祝；内置**六种人设**（傲娇/元气/天然呆/三无/温柔治愈/病娇）覆盖全部台词，支持用户在**插件独有 JSONC 配置文件**中添加自定义人设（内置注释版女仆彩蛋）；内置策展模型 URL 清单（默认 Hiyori），支持加载用户自备模型 URL。模型一律 URL 直载、不随包分发。默认开启、默认右下角、小尺寸、可一键隐藏。

## 2. 启用与设置

- 插件启用后宠物默认显示在**右下角**（停靠角固定右下角，不可配置；拖动后可自由放置）
- 设置入口：DSH 设置面板顶层「桌宠配置」tab（`settings.section`）；配置持久化经 Host `ctx.settings`（`$DSH_HOME/settings.yaml` 用户层覆盖 cordis.yml base 配置，ADR-002）
- 设置项（六项）：
  - 开关（显示/隐藏）
  - 尺寸滑杆（40–400px，默认 160）
  - **渲染帧率**（尺寸下方独立分组，标题「渲染帧率」）：一行三个**自绘圆形单选**（○ 30 / ○ 60 / ○ 不限制帧率；配置值 `maxFps`：`30` / `60` / `0`）；默认 **30**；改档经 SSE **立刻**作用到 PIXI `ticker.maxFPS`（`0` = 不设上限），无需重启/刷新；圆点样式与模型列表单选**共用同一自绘控件**（不使用原生 radio，避免深色主题白框）
  - **人设**（独立分组，标题「人设台词」）：下拉切换（内置六种 + 自定义人设自动出现）+ 文件工具行；切换后全部台词即时换语气（SSE 推送，无需重启/刷新）
  - 模型列表：内置策展清单（只读，含许可信息）+ 用户自定义模型（可添加 / 删除 / 修改，添加只需名称 + `.model3.json` URL；**可选**填写空间回退分区覆盖 `spatialTap`；**可选**配置**动画映射**——实时解析模型动作组，为 5 个状态 + 4 个互动部位各挂多个动作组，多选=触发时随机选一个，未配置槽位沿用默认）；选中项决定加载模型
  - **开发者选项**（独立分组）：总开关 `developerMode`（默认关）；开启后显示**调试面板**开关（`debug`，默认关）与**显示点击分区**（`showTapZones`，默认关；与调试面板可独立开关），并在「内置模型（只读）」标题右侧显示「打开内置模型配置文件」按钮（经 DSH `openPath` 打开 `src/presets/presets.jsonc`，打不开则弹层提示路径）
- **自定义人设（人设区工具行）**：
  - 「↻ 重新读取」：Host 现读人设文件 + SSE 推送，宠物与下拉**当场更新**（不重启不刷新；文件改坏时保留上一份好配置并在页面提示）
  - 「自定义人设 ↗」：优先经 DSH `host.openPath` 用系统默认程序打开 `$DSH_HOME/live2d-pet/personas.jsonc`；打不开则弹层兜底（一键复制文件路径 + 一键复制女仆模板）
  - 人设文件为**插件独有 JSONC**（允许注释）：首次启动落地模板（含使用说明 + **注释版女仆人设彩蛋**——取消注释、点「重新读取」即得），此后插件**只读不写**；用户复制粘贴模板块即可增加自己的性格预设
- 调试面板（debug 开启时显示）：实时 agent 状态、宠物当前状态/动画、模型信息（尺寸/缩放/命中区名）、最近气泡、错误日志、FPS；提供「演示状态」切换（强制 空闲/思考/等待/完成/出错）用于测试状态机；与宠物同顶层容器（ADR-005），关闭时零渲染
- **点击分区叠加**（`showTapZones`）：在模型上叠加空间回退四档色块（头/身/手/腿，与分档阈值一致，pointer-events:none）；经设置「开发者选项」开关，可与调试面板独立启用
- 宠物悬浮菜单（右键或悬浮时出现）：隐藏、设置、切换到空闲/思考演示动画（调试用）

## 3. 状态镜像（核心）

状态机五态，映射到真实 DSH 事件（ADR-002）。**全部台词按人设切换**（六内置 + 自定义）：

| 宠物状态 | 触发事件 | 表现（动作/表情 + 气泡） |
|----------|----------|--------------------------|
| 空闲 | `agent/status` status=idle（非刚完成） | 待机动画（眨眼/呼吸/发呆）；偶发瞬态气泡（人设 idle 池） |
| 思考中 | `agent/status` status=running | 歪头/敲键盘动画；气泡**常驻**，文案随思考时长阶段演进（见下） |
| 出错 | `agent/error` | 委屈表情；瞬态气泡（人设 error 池） |
| 完成 | `agent/turn-stopping` + running→idle 下降沿 | 欢呼/撒花动画；瞬态气泡（人设 done 池） |
| （可选）等审批 | `approval/request` | 张望动作；气泡**常驻**，文案随等待时长阶段演进（见下） |

- 状态变化即时反映（事件驱动，无轮询延迟感知）
- **长状态气泡与状态同生命周期**：思考中/等审批可持续数十秒以上，其气泡不再定时消失，而是常驻显示并按入态后耗时**阶段演进**文案（取当前人设的 thinking1..3 / waiting1..3 池）——
  - 思考中：入态 → 约 15s → 约 40s（三阶段）
  - 等审批：入态 → 约 30s → 约 90s（三阶段）
  - 每次阶段切换重播一次状态动作；状态一变立即切换为新状态的表现
- 空闲/出错/完成为短状态：气泡仍为瞬态（显示约 2.5s 后自动隐藏）
- **人设体系**：
  - 六种内置性格（下拉顺序即此）：**傲娇（默认）/ 元气 / 天然呆 / 三无 / 温柔治愈 / 病娇**；每套 13 池台词（idle/error/done + thinking1..3 + waiting1..3 + tapHead/tapLeg/tapArm/tapBody）
  - 自定义人设（JSONC 文件）：`base` 继承（沿链逐层覆盖，缺省池沿用基座，最终兜底默认人设）、只覆盖想改的池；id 唯一且不撞内置；坏条目跳过、文件写坏保留上次好结果并提示
  - 切换/重读即时生效；思考中途切人设，当前阶段气泡立即换新语气重绘（不打断计时节奏）
- 气泡文案风格：**中文、人设化**（傲娇结巴否认、元气叹号、天然呆咦、三无句号、温柔波浪、病娇偏执）；内置文案池常量内置，自定义走人设文件

## 4. 触摸互动

命中检测按模型自带 HitArea（`hitTest(x,y)` 返回命中区域名数组，画布世界坐标），按**优先级 头 > 腿 > 手 > 身体**归类；未匹配的命中区域归身体档；点击落在所有命中区域外且不在模型包围盒内则不响应：

- **摸头**（命中区域名含 head/hair/face/头）：专属享受候选动作 TapHead→TapBody + 人设 tapHead 池气泡
- **摸腿**（命中区域名含 leg/foot/feet/shoe/腿/脚）：TapLeg→TapBody + 人设 tapLeg 池气泡
- **摸手**（命中区域名含 arm/hand/手）：TapArm→TapBody + 人设 tapArm 池气泡
- **摸身体**（其余命中区域）：TapBody + 人设 tapBody 池气泡
- **HitArea 不足时的空间回退**（如 Hiyori 仅 `Body`，或 Haru 仅有 Head+Body）：命中名为头/腿/手时仍以名为准；命中为空、或仅为身体/未识别名时，若点击落在模型包围盒内的**有效分区矩形**内则按部位分档，否则不响应
- **空间回退阈值**（`spatialTap`，相对包围盒 0–1）：竖向用 `headMaxNy` / `legMinNy` / `armMinNy`；横向用**居中列**（`headMinNx`–`headMaxNx` 管头，`bodyMinNx`–`bodyMaxNx` 管身与腿）+ **两侧手臂列**（`armLeftMinNx`–`bodyMinNx`、`bodyMaxNx`–`armRightMaxNx`，高度在 `armMinNy`–`legMinNy`）。盒内但不落在任一矩形上 → 不响应。全局有默认；**内置策展条目与自定义模型均可可选覆盖**（缺省字段沿用默认）。生效阈值随当前选中模型经 SSE 下发；`showTapZones` 色块与真实分档共用同一套（画五个矩形，非整宽横条）
- **点击/拖动判定**：按下后指针移动 ≤ 6px 松手 → 判定为**点击**（触发触摸互动）；移动 > 6px → 判定为**拖动**（取消本次触摸互动）
- **拖动（自由位置）**：实时跟随指针，拖拽中暂停气泡与触摸互动；松手后**停留在释放位置**，位置持久化（right/bottom，`persist.ts`）
- **防刷屏**：点击互动仅保留 **80ms** 防抖（挡同一次 pointer 误触双发）；**不再**等气泡播完才能再点。每次有效点击立刻换一条随机点击台词并**重播**互动动作；随机时在同一池内**避开上一条**（池 ≥2）。交互气泡可短暂抢占长状态常驻气泡，显示结束后回到当前阶段文案
- 互动动画可打断当前状态动画与上一次互动动画，结束后回到当前状态对应的动画
- **动作优先级**：待机动作按 `IDLE` 优先级播放；思考/出错/完成/等待等状态动作与四档互动动作均按 `FORCE` 优先级播放。状态动作可立即切换（含长状态阶段重播），互动可打断状态动画与上一次互动
- **互动动作映射**：自定义模型可在「动画映射」中为摸头/摸腿/摸手/摸身体配置动作组；未配置时沿用默认 `TapHead→TapBody` 等候选链
- **动作期间抑制鼠标跟随**：播放任何非 idle 动作时，宠物先复位正视前方并暂停鼠标跟随，动作真正播完（`motionFinish`）后恢复跟随；避免摸头等动作的头部动画被鼠标转向叠加扭曲
- **点击台词池**：内置六人设每个部位（tapHead/tapLeg/tapArm/tapBody）约 **4–5** 条，减轻连点重复感；女仆模板彩蛋同步加厚；自定义人设可不覆盖完整条数（沿用 base）
- **拖动与气泡**：拖拽中隐藏气泡（含长状态常驻气泡，阶段静默推进）；松手后若处于长状态则恢复显示当前阶段文案
- **鼠标跟随（默认开启，无设置项）**：鼠标在页面任意位置移动时，宠物头部/眼睛/身体平滑看向鼠标（`model.focus(canvasLocalX, canvasLocalY)`，映射 `ParamAngleX/Y/Z` + `ParamEyeBallX/Y` + `ParamBodyAngleX`；身体转动由 `ParamBodyAngleX` 体现，依赖模型自带标准参数）；**拖拽中不更新视线**，避免拖动时头部乱转；鼠标移出页面/窗口后复位正视前方；宠物隐藏（`enabled=false`）或页面失焦/隐藏时不跟随

## 5. 任务完成庆祝

- 触发：思考中 → 空闲 的下降沿（一轮工作结束）
- 表现：欢呼/撒花动画 + "搞定！"气泡，持续约 3 秒后回到空闲态
- v0.1 不含音效（资源与许可成本，v0.2 再议）

## 6. 模型清单与加载

- 模型一律 **URL 直载**：宠物从选中模型解析出的 `.model3.json` URL 加载，**不随包分发任何模型文件**
- **内置模型清单**（`src/presets/presets.jsonc`，设置面板模型列表的只读部分，JSONC 支持注释）：策展的 URL 条目，**只读不可增删改**。**已定稿 5 条**（2026-08）：Hiyori / Haru / Mao / Mark / Natori，均为 Live2D 官方示例模型（Cubism 4，商用可用，需标注著作权；[示例模型条款](https://www.live2d.com/eula/live2d-sample-model-terms_cn.html)）
- 清单门槛为**许可可标注**：每条记录模型名称、作者、许可类型与许可链接（点击可查看），**不做许可合规判断**；NC（禁止商用）模型可收录，但列表中**明确标注"仅限非商用"**；条目可可选附带 `spatialTap`（如 Hiyori 的居中分区矩形）覆盖该模型空间回退
- **默认模型商用安全**：默认 Hiyori（商用可用），插件装完自动加载不会把用户带入 NC 使用
- **自定义模型**：设置面板「模型列表」中可**添加 / 删除 / 修改**用户自备模型（名称 + `.model3.json` URL，零许可风险路径）；URL 框支持**远程 http(s) URL 或本地绝对路径**（Unix `~`/`/home/…`、Windows `C:/…`）；URL 框右侧提供**「选择本地文件」按钮**——打开插件自研的**目录浏览弹层**（Host 侧 Node `fs` 扫描 `POST /api/live2d-pet/list-local-dir`，逐级进子目录、点 `.model3.json` 文件回填其**绝对路径**；不依赖 DSH `directoryPicker` 服务，见 ADR-010）；本地路径由 Host 映射为同源虚拟路由 `/pet-local-models/<id>/<fileName>` 供浏览器加载（ADR-010）。编辑时可展开**空间分区覆盖（可选）**，按字段填写 0–1 相对比例（留空=该字段用全局默认）；编辑时可展开**动画映射（可选）**：实时解析该模型 `.model3.json` 的 `Motions` 动作组，为 5 个状态（空闲/思考/出错/完成/等待审批）与 4 个互动部位（摸头/摸腿/摸手/摸身体）各选择多个动作组；多选不做排序，触发时随机选一个播放；未配置槽位沿用内置默认候选链；解析失败仍可保存模型，映射区提示“无法解析动画列表，可稍后重试”；自定义条目持久化到 `$DSH_HOME/live2d-pet/custom-models.jsonc`，与内置清单合并展示、均可选中；删除/修改仅作用于自定义条目
- **加载失败兜底**：显示静态头像占位 + 错误气泡提示，不影响 GUI 其它功能；可从设置切换其它模型

## 7. 性能与不打扰

- 标签页隐藏 / 窗口失焦：暂停渲染循环（保留最后画面），恢复时继续
- 渲染帧率由设置 **`maxFps`** 控制（PIXI `ticker.maxFPS`）：默认 **30**；可选 **60** 或 **0（不限制帧率）**；尺寸变更经 rAF **合并落地**（只应用最后一档），避免连发配置推送时同步 WebGL resize 卡死主线程
- WebGL 不可用或 FPS 持续过低：自动降级为**静态头像模式**（不启动渲染循环）
- 一键隐藏后完全不渲染（零开销）；隐藏状态持久化
- 默认小尺寸、右下角，不遮挡对话主操作区；可随时拖动/关闭

## 8. 验收要点

- [ ] 启用后宠物出现在右下角；拖动到任意位置松手后停留并持久化（刷新后位置保持）
- [ ] 拖动与点击互不误触：快速点击触发互动，按住移动触发拖动（6px 阈值）
- [ ] agent 思考/空闲/出错/完成时，动画与气泡与状态一致（用真实事件触发验证）
- [ ] 长思考（>40s）期间气泡常驻且文案按阶段推进两轮；审批等待同理；状态切换时气泡立即切换为新状态表现
- [ ] 思考中点击宠物：交互气泡短暂抢占，结束后回到当前阶段文案；拖拽中气泡隐藏、松手恢复
- [ ] 摸头/摸腿/摸手/摸身体各自触发对应文案与动作（有命名 HitArea 时按名；仅 Body 等不足模型按包围盒空间分档；无命中且在盒外不响应）；连点可立刻换台词+重播动作（仅 80ms 防抖；随机避开上一条）
- [ ] 鼠标在页面任意位置移动时宠物头/眼/身体平滑跟随；拖拽中不跟随；鼠标移出页面后复位正视前方；隐藏宠物后不跟随
- [ ] 完成庆祝动画在任务结束后出现并回到空闲态
- [ ] 模型清单条目许可信息可见（类型 + 链接，NC 有标注）；默认模型（hiyori）可加载；5 条内置条目均可选中加载；加载失败显示静态头像
- [ ] 标签页隐藏后渲染暂停；WebGL 不可用时为静态头像
- [ ] 设置面板「桌宠配置」tab 出现（`settings.section`）；开关/尺寸滑杆/**渲染帧率（30/60/不限制）**/**人设下拉**/调试模式生效并持久化（改完刷新后仍在；cordis.yml 配置仍作为 base 层生效）；改帧率档立刻反映到渲染循环
- [ ] 人设：六内置可切换且全部台词（状态/阶段/四档互动）随即换语气；自定义人设出现在下拉并可选中；思考中途切换当前阶段气泡立即换语气
- [ ] 自定义人设文件：首启动落地模板（含注释版女仆彩蛋）；取消注释女仆 → 点「↻ 重新读取」→ 下拉出现「女仆」；文件写坏 → 保留上次结果 + 设置页提示；「自定义人设 ↗」可打开文件或弹层复制路径/模板
- [ ] 模型列表：内置条目只读展示（含许可信息）；自定义模型可添加（名称+URL）/删除/修改并持久化；选中自定义模型可正常加载；加载失败显示静态头像；自定义模型可选覆盖 `spatialTap` 后，分区色块与点击分档随该模型生效（切回内置恢复默认）
- [ ] debug 开关生效：开启显示调试面板、关闭零渲染；「演示状态」切换可强制宠物状态

## 9. 技术边界（实现约定，非用户行为）

- 渲染：pixi-live2d-display 0.4.0 + PixiJS 6.5.10 + Cubism Core 4（ADR-003；ADR-001 已被其取代）
- 挂载：Client Slot `shell.overlay`；设置入口：Client Slot `settings.section`（独立设置页，ADR-002）+ Host `ctx.settings` namespace（`$DSH_HOME/settings.yaml`；base = cordis.yml 条目 config 子集，用户层覆盖；自定义模型条目存于 `$DSH_HOME/live2d-pet/custom-models.jsonc`，不再写入 settings.yaml）
- 设置传输：**不走 settingsScope wire**（dsh-host-apiproxy 白名单不暴露第三方 namespace，官方 deferred work，见 research 3.4）；改走插件自身同源 API `GET/POST /api/live2d-pet/settings`（Host 直连 `ctx.settings`，持久化语义不变，research 3.5）
- 同源 POST 约定：所有 `POST /api/live2d-pet/*` 请求**必须带 `Content-Type: application/json` 头**（无参 POST 用空 body `{}`），否则被 dsh-host-apiproxy 在分发前以 **415 Unsupported Media Type** 拒绝（apiproxy 对所有 `/api` POST 强校验 JSON 媒体类型）
- 状态源：Host 订阅 `agent/status`、`agent/error`、`agent/turn-stopping` 等（ADR-002）
- 状态传输：Host→Client 经同源 **SSE 端点 `/api/live2d-pet/events`** 推送（连接即回发快照 + 变更推送 + 30s 心跳，ADR-006），替代 v0.1 的 800ms 轮询；初始首帧仍走 `GET /api/live2d-pet/state`
- **人设体系**（ADR-007）：
  - 内置六人设文案常量在 client（`src/client/personas.ts`）；自定义人设走**插件独有 JSONC 文件** `$DSH_HOME/live2d-pet/personas.jsonc`（零接触 DSH settings yaml 体系）——首启动落地模板后只读不写
  - Host `PersonasStore` 每次快照**现读**该文件（无缓存：刷新页面即生效）；`POST /api/live2d-pet/reload-personas` 重读 + version bump + SSE 推送（「↻ 重新读取」按钮）
  - `PetStateView` 携带 `config.persona` + `customPersonas`（原样定义）+ `personasError` + `personasFile`；client 按 base 链本地合并出完整台词表（内置表不重复下发）
  - 命中检测：pixi-live2d-display `hitTest(x, y)` 吃画布世界坐标、返回命中区域名数组（v0.1 曾误用 `(name,x,y)` 恒真值导致全身判为头）；部位按正则分桶 + 优先级 头>腿>手>身体
  - 鼠标跟随：pixi-live2d-display `model.focus(x, y)` 吃 PIXI world space（canvas 本地坐标），内部 `FocusController` 平滑插值并映射 `ParamAngleX/Y/Z` + `ParamEyeBallX/Y` + `ParamBodyAngleX`；复位时直接置 `internalModel.focusController.focus(0, 0, true)`
  - 动作管理：pixi-live2d-display `MotionPriority`（IDLE=1 / NORMAL=2 / FORCE=3），idle 用 IDLE、状态与互动用 FORCE；重播同一动作前先 `stopAllMotions()`；`motion()` 的 Promise 只代表开始，完成信号统一用 `motionFinish`（ADR-008）
  - focus 抑制：非 idle 动作播放期间 `focusController.focus(0, 0, true)` 归零 + `pointermove` 门控，`motionFinish` 后恢复跟随（ADR-008）
  - 动画映射：`resolveMotionMap()` 合并 `DEFAULT_MOTION_MAP` + 自定义条目 `animationMap` / 内置 preset `animationMap`，经 `PetStateView.config.motionMap` 下发 client；自定义条目动画映射在设置页实时解析 `.model3.json` 的 `Motions` 动作组，多选=随机选择（ADR-009）
  - debug 预览：调试面板直接解析当前模型 `.model3.json` 的 `Motions`，列出**模型原生全部具体动画**（按动作组分组的文件列表）；选择后直接 `model.motion(group, index, FORCE)` 播放，不掺入插件状态机/焦点/恢复逻辑（ADR-009）
  - 「自定义人设 ↗」经 client `ctx.get('workspaces').openPath`（DSH host.openPath 能力）打开文件；不可用时弹层兜底（复制路径/模板）
- 模型清单条目许可可标注（类型 + 链接，NC 标注）；默认模型商用安全；SDK 按 Live2D 官方条款
- **spike 结果（见 ADR-003）**：WebGL ✅ / DOM·script 注入 ✅ / CDN 脚本加载 ✅ / Host→Client 轮询 ✅ / 模型渲染 ✅ / 动作·表情 ✅ / 触摸命中 ✅；Cubism 5 兼容未验证
- **已定稿（原待定项，结论并入对应章节）**：
  - 插件分发/安装形态 → **npm 包 + `cordis.patch.yml` bundle patch**（官方 publish.md 流程，`dsh plugin --profile web add dsh-live2d-pets`；README 快速开始，ADR-004）
  - 模型清单逐条定稿 → **§6 已定稿 5 条**（Hiyori/Haru/Mao/Mark/Natori，同 Live2D 示例模型条款，逐条记录许可类型与链接）

## 10. v0.1 明确不做

- 喂食/养成玩法（v0.2）
- 通知中心替代
- 完整通用 Live2D 运行时
- 音效、模型市场
- **设置页内的文案编辑器**（自定义人设只走 JSONC 文件路线）；**人设随机切换/混合人格**；**fs.watch 文件监听热重载**（重读由「↻ 重新读取」按钮显式触发）
- 重置位置按钮、隐藏快捷键、可配置停靠角（默认固定右下角）、尺寸三档（用连续滑杆）
- 自定义模型的全字段元信息（作者/许可/Cubism 版本——自定义条目仅名称 + URL；内置策展清单仍全字段）
