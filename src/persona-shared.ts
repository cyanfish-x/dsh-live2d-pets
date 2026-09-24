/**
 * 人设共享层（Host 与 client 两半区共用，纯常量与类型，零平台依赖）。
 * - CopyTable：一整套台词池（14 池：4 短状态 + 思考/等审批各 3 阶段 + 4 部位互动）
 * - CustomPersonaDef：$DSH_HOME/live2d-pet/personas.jsonc 里的自定义人设条目
 * - PERSONAS_TEMPLATE：首次落地到上述文件的内容（JSONC，含注释版女仆彩蛋）
 * @module dsh-live2d-pets/persona-shared
 */

/** 一整套人设台词池（flat 阶段键，便于用户手写 JSON）。 */
export interface CopyTable {
  idle: string[]
  error: string[]
  done: string[]
  delivered: string[]
  thinking1: string[]
  thinking2: string[]
  thinking3: string[]
  waiting1: string[]
  waiting2: string[]
  waiting3: string[]
  tapHead: string[]
  tapLeg: string[]
  tapArm: string[]
  tapBody: string[]
}

/** 台词池键（CopyTable 的键序即设置文档中的说明顺序）。 */
export type CopyKey = keyof CopyTable

/** 全部台词池键（自定义条目校验/合并用）。 */
export const COPY_KEYS: readonly CopyKey[] = [
  'idle', 'error', 'done', 'delivered',
  'thinking1', 'thinking2', 'thinking3',
  'waiting1', 'waiting2', 'waiting3',
  'tapHead', 'tapLeg', 'tapArm', 'tapBody',
] as const

/** 内置人设 id（顺序即设置页下拉顺序）。 */
export const BUILTIN_PERSONA_IDS = ['tsundere', 'genki', 'airhead', 'kuudere', 'healing', 'yandere'] as const

/** 内置人设 id 类型。 */
export type BuiltinPersonaId = typeof BUILTIN_PERSONA_IDS[number]

/** 默认人设 id。 */
export const DEFAULT_PERSONA_ID: BuiltinPersonaId = 'tsundere'

/** 自定义人设条目（personas.jsonc）。 */
export interface CustomPersonaDef {
  id: string
  /** 设置页下拉显示名（缺省用 id）。 */
  name?: string
  /** 继承的基座人设 id（内置或其它自定义；缺省 tsundere）。 */
  base?: string
  /** 只覆盖想改的台词池，其余回退基座。 */
  copy?: Partial<CopyTable>
}

/**
 * 自定义人设文件模板（JSONC）：首次启动原样落地到
 * $DSH_HOME/live2d-pet/personas.jsonc；此后插件只读不写，注释永存。
 * 女仆人设以注释形态预置——取消注释、点「重新读取」即得（彩蛋）。
 */
export const PERSONAS_TEMPLATE = `{
  // ============================================================
  // dsh-live2d-pets 自定义人设配置（JSONC：允许注释）
  // ------------------------------------------------------------
  //  · 每个人设是一个对象，放进 "personas" 数组即可
  //  · id   ：唯一英文标识（出现在设置页下拉里）
  //  · name ：下拉显示名（缺省用 id）
  //  · base ：继承哪个人设（内置：tsundere/genki/airhead/kuudere/healing/yandere，
  //           也可填其它自定义 id）；没写的台词池沿用基座的
  //  · copy ：想覆盖的台词池（14 池：idle/error/done/delivered、
  //           thinking1~3、waiting1~3、tapHead/tapLeg/tapArm/tapBody）
  //  · 改完保存 → 设置页「人设」区点 ↻ 重新读取 即时生效（宠物当场换台词）
  //
  // ↓↓↓ 彩蛋：把下面整块取消注释，点「重新读取」，下拉里就会出现女仆 ↓↓↓
  //
  // {
  //   "id": "maid",
  //   "name": "女仆",
  //   "base": "healing",
  //   "copy": {
  //     "idle": ["主人在，就一直待命哦。", "主人，有什么吩咐吗？"],
  //     "error": ["非常抱歉主人…马上处理！", "出错了…女仆的失职，请责罚。"],
  //     "done": ["任务完成，主人请过目！", "做好了…有奖励吗，主人？"],
  //     "thinking1": ["遵命，思考中…", "让女仆想想…"],
  //     "thinking2": ["还在努力，请稍候…", "马上就好，主人…"],
  //     "thinking3": ["这道题有点难呢…", "很快就好，请再等等…"],
  //     "waiting1": ["等主人拍板哦。", "主人慢慢考虑。"],
  //     "waiting2": ["不着急，女仆一直都在。", "您考虑，我侍立一旁。"],
  //     "waiting3": ["女仆先退下待命…主人随时吩咐。", "等候多时了，主人。"],
  //     "tapHead": ["主人的手…好幸福…", "谢谢主人的抚摸！", "再摸一下…可以吗，主人？", "被主人摸头…好安心…", "头发乱了也没关系…主人喜欢就好。"],
  //     "tapLeg": ["那、那里不行的，主人！", "讨厌…会痒的…", "腿…请温柔一点…", "主人好坏…专戳那里…", "站不稳了…请扶着我…"],
  //     "tapArm": ["可以牵着主人…吗？", "与主人击掌！", "手…一直想牵着您…", "击掌！女仆会更努力！", "握住就不想松开了…"],
  //     "tapBody": ["主人想按摩吗？", "嘿嘿…主人真贪心。", "身体…请随便吩咐…", "再戳…女仆会害羞的…", "主人的手好温暖…"]
  //   }
  // }
  //
  // ↑↑↑ 彩蛋结束。想加自己的人设：复制上面整块、改 id/name/台词，加进数组 ↑↑↑
  // ============================================================
  "personas": []
}
`
