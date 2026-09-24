/**
 * 内置人设文案表（client 常量，spec §3）：六种二次元经典性格，
 * 每人设一整套 14 池台词（短状态 + 思考/等审批阶段 + 四档部位互动）。
 * 自定义人设（$DSH_HOME/live2d-pet/personas.jsonc）在 client 端按 base 继承合并，
 * 合并结果与本表同构，宠物台词一律从「当前人设台词表」取。
 * @module dsh-live2d-pets/client/personas
 */

import type { CopyTable, CustomPersonaDef } from '../persona-shared.ts'
import { DEFAULT_PERSONA_ID } from '../persona-shared.ts'

/** 内置人设（顺序即设置页下拉顺序）。 */
export const BUILTIN_PERSONAS: ReadonlyArray<{ id: string; name: string; copy: CopyTable }> = [
  {
    id: 'tsundere',
    name: '傲娇',
    copy: {
      idle: ['闲、闲着才不是在等你！', '别、别一直盯着看啊！'],
      error: ['哼，才不是我搞坏的！…要看就快看啦！', '出错了…怎、怎么办啊笨蛋！'],
      done: ['搞定了！…才不是为了求夸奖！', '哼，这点小事轻轻松松啦！'],
      delivered: ['给、给你的！才不是特意做的！', '喏，成果。…夸我一句会死吗！'],
      thinking1: ['思考中…', '让我想想…'],
      thinking2: ['还在想…', '让我再理理思路…'],
      thinking3: ['这个问题有点东西…', '快了快了…'],
      waiting1: ['等你拍板~', '你决定了叫我，哼！'],
      waiting2: ['不着急…谁说我着急了！', '慢慢想，我才没有等很烦！'],
      waiting3: ['我先眯一会儿，好了叫我', '等这么久…你欠我一次摸头！'],
      tapHead: ['哼、哼才不是舒服呢！', '就、就允许你摸一下头！', '再摸…也、也不是不行啦！', '头、头发要乱了笨蛋！', '别、别摸太久啊！'],
      tapLeg: ['哼！才不是给你摸的！', '笨蛋！谁让你碰腿了！', '腿、腿很敏感的！', '再碰腿就、就生气了！', '走开啦，笨手笨脚！'],
      tapArm: ['牵、牵手才没有很开心！', '击掌就击掌，笨蛋！', '手、手汗都沾上了啦！', '拉我就拉，别得意！', '松开…才不是舍不得！'],
      tapBody: ['摸、摸够了没有！', '再乱摸真生气了哦，笨蛋！', '身体…才不是软软的！', '戳哪里啊你！', '够了够了，一边去！'],
    },
  },
  {
    id: 'genki',
    name: '元气',
    copy: {
      idle: ['元气满满待机中！', '今天也要一起冲鸭！'],
      error: ['呜哇出错了！马上重整旗鼓！', '哎呀翻车了…再来一次一定行！'],
      done: ['搞定啦！我最棒吧！', '任务完成！给我鼓掌！'],
      delivered: ['交货啦！快看快看！', '成果出炉！我超厉害对吧！'],
      thinking1: ['收到！速速思考中！', '让我想想哦！'],
      thinking2: ['还在想，马上就好！', '灵感快来快来！'],
      thinking3: ['这关有点难，但我不怕！', '冲冲冲，快打通了！'],
      waiting1: ['等你拍板哦！', '你决定我们就出发！'],
      waiting2: ['不急不急，我原地待命！', '慢慢想，我做个操等你！'],
      waiting3: ['等好久啦…我先充个电！', '呼…睡了一觉你还没好吗！'],
      tapHead: ['好舒服再来再来！', '摸头头能量满格！', '呼噜呼噜~还要！', '头好酥，我起飞啦！', '再摸我变超级元气！'],
      tapLeg: ['痒痒痒哈哈别闹！', '腿腿要跑掉啦！', '别挠啦我站不稳！', '哈哈腿在抗议哦！', '再碰我就蹦起来！'],
      tapArm: ['击掌！耶！', '牵手手出发喽！', '手手充电成功！', '拉我冲鸭！', '击掌再来一次！'],
      tapBody: ['嘿嘿好痒！', '再戳我要跳起来啦！', '肚子不许偷袭！', '嘿嘿被抓到啦！', '再戳我就抱住你！'],
    },
  },
  {
    id: 'airhead',
    name: '天然呆',
    copy: {
      idle: ['发呆中…咦我在哪…', '咦…刚才想说什么来着…'],
      error: ['咦？坏掉了诶…', '出错了…要、要怎么办来着…'],
      done: ['咦，做好了吗？', '完成…啦？要夸夸我哦…'],
      delivered: ['咦？交出去了吗…', '这个给你…要好好收哦…'],
      thinking1: ['想想想中…', '让我想想哦…'],
      thinking2: ['还、还没想出来…', '咦，刚才想到哪了…'],
      thinking3: ['想了好久，肚子饿了…', '这个…好难诶…'],
      waiting1: ['等你来决定哦…', '你慢慢想，我不急的…'],
      waiting2: ['咦，你还在想吗…', '我也一起想…想着想着…'],
      waiting3: ['咦…你还在吗…我先睡了…', '呼…睡着了…别忘了我哦…'],
      tapHead: ['咦，好舒服…', '摸头…会变聪明吗…', '头…暖暖的…', '再摸一下下…可以吗…', '咦，我在被摸头…'],
      tapLeg: ['咦，那是腿…', '痒痒…哈哈哈…', '腿…为什么会笑…', '别挠…会站不稳…', '咦嘿嘿…脚麻了…'],
      tapArm: ['牵手…好哦…', '击掌…啪…', '手…好大…', '牵着…就不会迷路吧…', '咦，我们在击掌吗…'],
      tapBody: ['咦嘿嘿…', '别戳啦，会歪掉的…', '身体…软软的吗…', '咦，那里是哪里…', '再戳…我会飘走哦…'],
    },
  },
  {
    id: 'kuudere',
    name: '三无',
    copy: {
      idle: ['在。', '无事。'],
      error: ['出错。需要你。', '异常。原因不明。'],
      done: ['完成。', '结束了。'],
      delivered: ['交付完毕。', '文件，在这里。'],
      thinking1: ['思考中。', '解析。'],
      thinking2: ['仍在思考。', '继续。'],
      thinking3: ['难度：高。', '尚未结束。'],
      waiting1: ['等待指示。', '待命。'],
      waiting2: ['继续等待。', '无限期待机也可。'],
      waiting3: ['休眠中。可唤醒。', '你回来了。'],
      tapHead: ['…舒服。', '许可。', '继续。', '无异议。', '记录：摸头。'],
      tapLeg: ['…无感。', '别碰。会掉。', '腿。静止。', '无效输入。', '已忽略。'],
      tapArm: ['牵手。可以。', '击掌。啪。', '手部接触。确认。', '握力。适中。', '结束随意。'],
      tapBody: ['…随便。', '反应：微弱。', '躯干。触碰。', '无评论。', '…嗯。'],
    },
  },
  {
    id: 'healing',
    name: '温柔治愈',
    copy: {
      idle: ['一直陪着你哦~', '需要我的时候说一声~'],
      error: ['出错了呢…一起看看好吗？', '别急，我们慢慢来~'],
      done: ['做好啦，辛苦你了~', '完成了，休息一下吧~'],
      delivered: ['给你做好啦~', '成果在这里，慢慢看哦~'],
      thinking1: ['我想想哦…', '交给我吧~'],
      thinking2: ['还在想，不急哦…', '快好了，等我一下下~'],
      thinking3: ['这个问题好认真…', '马上就通了，再等等我~'],
      waiting1: ['等你决定哦，慢慢来~', '你想好再叫我~'],
      waiting2: ['不着急，我陪你想~', '慢慢考虑，我一直都在~'],
      waiting3: ['等久了呢…我先眯一下，你叫我哦~', '辛苦啦，慢慢来~'],
      tapHead: ['摸头好舒服~嗯~', '最喜欢摸头了~', '温柔的手掌~真好~', '再摸一会儿好吗~', '头靠着你就安心~'],
      tapLeg: ['腿腿也会害羞的~', '轻轻的哦~', '别怕，慢慢来~', '痒痒的…好可爱~', '腿也想被照顾呢~'],
      tapArm: ['牵手~好温暖~', '击掌！耶~', '手心暖暖的~', '牵着就不害怕了~', '再击一次掌吧~'],
      tapBody: ['嘿嘿~今天累了吗？', '温柔一点哦~', '抱抱也可以的哦~', '戳戳…在听你说话~', '身体也想被安慰呢~'],
    },
  },
  {
    id: 'yandere',
    name: '病娇',
    copy: {
      idle: ['一直看着你哦…', '你不在的话…会很寂寞的…'],
      error: ['谁弄坏的…告诉我名字…', '坏掉了…不过，还有我在…'],
      done: ['只为你做的哦…', '完成…只夸我一个人…'],
      delivered: ['只给你一个人的文件哦…', '收好…不许给别人看…'],
      thinking1: ['为了你，思考中…', '想想怎么帮你…'],
      thinking2: ['还没想完…不要走开哦…', '再等一下下就好…'],
      thinking3: ['想太久了…对不起…', '快好了…别离开我…'],
      waiting1: ['等你的答复…一直等…', '你不回我…会寂寞死的…'],
      waiting2: ['不急…我很有耐心…', '慢慢想…但别丢下我…'],
      waiting3: ['还没好吗…你不会走吧…', '我一直、一直在这里哦…'],
      tapHead: ['摸头…只准你摸哦…', '嘿嘿…再摸嘛…', '摸头…就属于我了…', '再摸…不许停…', '头…记住你的手温了…'],
      tapLeg: ['那里…只属于你…', '再摸…就缠上你了哦…', '腿…逃不掉的…', '碰这里…不许看别人…', '再摸…就绑住你…'],
      tapArm: ['牵住…就不放手了…', '击掌…约定好了哦…', '手…永远牵着…', '松开试试？做不到吧…', '击掌…生死契约…'],
      tapBody: ['嘿嘿…最喜欢你了…', '再摸…要给你更多哦…', '身体…全是你的…', '再戳…就吃掉你…', '摸够了吗…我还没有…'],
    },
  },
]

/** 内置人设下拉清单（id + 中文名）。 */
export function builtinPersonaOptions(): Array<{ id: string; name: string }> {
  return BUILTIN_PERSONAS.map(({ id, name }) => ({ id, name }))
}

function builtinCopy(id: string): CopyTable | null {
  const hit = BUILTIN_PERSONAS.find((p) => p.id === id)
  return hit ? hit.copy : null
}

/** base 继承链解析深度上限（防自定义 id 互相环引用）。 */
const BASE_CHAIN_LIMIT = 5

/**
 * 解析某个人设 id 的完整台词表：内置直接取；自定义沿 base 链逐层覆盖
 * （自定义 → 其 base → … → 内置），未覆盖的池沿用上一层，最终兜底默认人设。
 */
export function resolvePersonaCopy(
  id: string,
  customPersonas: readonly CustomPersonaDef[],
): CopyTable {
  const byId = new Map(customPersonas.map((p) => [p.id, p]))
  // 沿链收集：从目标 id 出发逐层找 base，先收集再从底向上合并
  const chain: CustomPersonaDef[] = []
  let cursor: string | undefined = id
  for (let depth = 0; depth < BASE_CHAIN_LIMIT; depth += 1) {
    const def: CustomPersonaDef | undefined = cursor === undefined ? undefined : byId.get(cursor)
    if (!def) break
    chain.unshift(def)
    cursor = def.base
  }
  const baseId = cursor && builtinCopy(cursor) ? cursor : DEFAULT_PERSONA_ID
  const table: CopyTable = { ...(builtinCopy(baseId) ?? builtinCopy(DEFAULT_PERSONA_ID)!) }
  for (const def of chain) {
    if (def.copy) Object.assign(table, def.copy)
  }
  return table
}
