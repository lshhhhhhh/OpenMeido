/**
 * In-memory fake MailAdapter for testing email-with-context flows that
 * the user's real inbox can't reproduce (e.g. paired reply summaries
 * when there are no replies on their actual server).
 *
 * Enable by setting `OPENMEIDO_FAKE_MAIL=1` in the env. mail-host.ts
 * picks this adapter instead of the IMAP one when that flag is set.
 *
 * Data is six synthetic threads + two standalones, designed to exercise:
 *   - Inbox reply WITH parent in Sent  → parent attached
 *   - Inbox reply WHOSE parent isn't on the server → parent === null
 *   - Inbox standalone (newsletter/alert, no In-Reply-To) → parent absent
 *   - listInbox(N) returning a mix of the above
 *   - readMessage walking up one level
 *
 * No external deps; pure data + filtering logic.
 */

import type { MailAdapter } from '../../core/mail/adapter.js'
import type { MailMessage, MailSummary, ListInboxOptions } from '../../core/mail/types.js'

/** Internal model — flat list, both folders mixed, denormalized for lookup. */
interface FakeMail {
  /** Unique id. INBOX items use a plain integer string ('101'); SENT items
   *  use 'sent:<n>' so readMessage routing matches the IMAP adapter shape. */
  id: string
  folder: 'INBOX' | 'SENT'
  from: string
  to: string[]
  subject: string
  body: string
  ts: string
  unread: boolean
  messageId: string
  inReplyTo?: string
}

// Self-deterministic so reruns / inspections match. NOT real people.
const ME = 'me@openmeido.test'
const ALICE = 'alice.chen@company.test'
const BOB = 'bob.zhang@company.test'
const CAROL = 'carol@company.test'
const DAN = 'dan.lin@vendor.test'
const ERIN = 'erin@onsite.test'
const FRANK = 'frank.li@bigcorp.test'
const NEWS = 'newsletter@infoq.test'
const ALERT = 'alerts@datadoghq.test'

const FAKE_DATA: FakeMail[] = [
  // ---------- Thread 1: LunarLink 1.2 release ----------
  {
    id: 'sent:1',
    folder: 'SENT',
    from: ME,
    to: [ALICE],
    subject: 'LunarLink 1.2 预发布时间确认',
    body:
      'Alice，\n\n' +
      'LunarLink 1.2 预发布版本目前的计划是下周一上线，前端 OAuth 回调那块还有没有阻塞？' +
      '如果赶不上的话，麻烦今晚之前给我一个新时间，我跟产品同步一下。\n\n' +
      '谢谢。',
    ts: '2026-05-12T09:14:00+08:00',
    unread: false,
    messageId: '<lunarlink-q1@openmeido.test>',
  },
  {
    id: '101',
    folder: 'INBOX',
    from: ALICE,
    to: [ME],
    subject: 'Re: LunarLink 1.2 预发布时间确认',
    body:
      '嗯…前端这边卡在 OAuth 回调的 state 校验，token 在 Edge 浏览器上偶尔丢失，' +
      '昨天复现了，今天还在排查。\n\n' +
      '建议预发布顺延到周三晚，给我们两天加固。周一肯定赶不上。\n\n' +
      'Alice',
    ts: '2026-05-15T17:32:00+08:00',
    unread: true,
    messageId: '<lunarlink-r1@company.test>',
    inReplyTo: '<lunarlink-q1@openmeido.test>',
  },

  // ---------- Thread 2: 灰度方案评审 ----------
  {
    id: 'sent:2',
    folder: 'SENT',
    from: ME,
    to: [BOB],
    subject: '请评审：灰度方案文档（重点回滚链路）',
    body:
      'Bob，\n\n' +
      '附件是支付链路灰度方案 v3，重点请帮我看回滚链路那一段——尤其是分批回滚的窗口设置是不是太激进了。\n\n' +
      '今天能给我反馈最好，明天上午要过架构评审。\n\n' +
      '感谢。',
    ts: '2026-05-13T11:02:00+08:00',
    unread: false,
    messageId: '<grayscale-q2@openmeido.test>',
  },
  {
    id: '102',
    folder: 'INBOX',
    from: BOB,
    to: [ME],
    subject: 'Re: 请评审：灰度方案文档（重点回滚链路）',
    body:
      '看完了，整体方向没问题。两点建议：\n\n' +
      '1. 回滚链路 OK，但当前文档里"5 分钟内自动判定失败"的窗口在我们这种支付场景偏短，' +
      '建议放到 15-20 分钟，给冒烟数据足够样本。\n' +
      '2. 分批灰度的"24 小时观察窗口"我觉得反而保守了，可以试试 8 小时 + 显式人工 ACK。\n\n' +
      '其他都 OK，明天评审我会到。\n\n' +
      'Bob',
    ts: '2026-05-13T16:48:00+08:00',
    unread: true,
    messageId: '<grayscale-r2@company.test>',
    inReplyTo: '<grayscale-q2@openmeido.test>',
  },

  // ---------- Thread 3: 候选人面试排期 ----------
  {
    id: 'sent:3',
    folder: 'SENT',
    from: ME,
    to: [CAROL],
    subject: '下周一二面排期请求',
    body:
      'Carol，\n\n下周一前我们有 3 个候选人需要二面（小张、小李、小王），方便帮我排一下吗？' +
      '每个 45 分钟，最好都在我日历上空着的时段。',
    ts: '2026-05-14T10:00:00+08:00',
    unread: false,
    messageId: '<interview-q3@openmeido.test>',
  },
  {
    id: '103',
    folder: 'INBOX',
    from: CAROL,
    to: [ME],
    subject: 'Re: 下周一二面排期请求',
    body:
      '周一日历看了一下：\n\n' +
      '- 小张：10:00-10:45 ✓\n' +
      '- 小李：11:00-11:45 ✓\n' +
      '- 小王：下午只剩 14:30-15:00 这半小时，超出 45 分钟需要他自己选另一天。\n\n' +
      '要我先发邀请吗？',
    ts: '2026-05-14T15:12:00+08:00',
    unread: true,
    messageId: '<interview-r3@company.test>',
    inReplyTo: '<interview-q3@openmeido.test>',
  },

  // ---------- Thread 4: 客户演示反馈 ----------
  {
    id: 'sent:4',
    folder: 'SENT',
    from: ME,
    to: [DAN],
    subject: '上周演示客户问题汇总',
    body:
      'Dan，把上周客户演示后收到的问题分类汇总一下给我，下周一开会要用。\n\n' +
      '主要想看的是产品质量类的，运营类的可以单列。',
    ts: '2026-05-15T08:30:00+08:00',
    unread: false,
    messageId: '<feedback-q4@openmeido.test>',
  },
  {
    id: '104',
    folder: 'INBOX',
    from: DAN,
    to: [ME],
    subject: 'Re: 上周演示客户问题汇总',
    body:
      '已附 PDF。三大类，按出现频次：\n\n' +
      '1. UI 卡顿（7/11 客户）— 多发于导出表格时的 spinner 期\n' +
      '2. 导出失败（4/11）— 都是 Excel 模板超过 50MB 的场景\n' +
      '3. 移动端兼容（3/11）— iOS Safari 上图表渲染错位\n\n' +
      '运营类问题单独发邮件给你。',
    ts: '2026-05-16T11:20:00+08:00',
    unread: true,
    messageId: '<feedback-r4@vendor.test>',
    inReplyTo: '<feedback-q4@openmeido.test>',
  },

  // ---------- Thread 5: 现场支持（reply but parent is NOT in our Sent） ----------
  // Tests the "parent === null" path: model sees inReplyTo set, parent
  // not findable.
  {
    id: '105',
    folder: 'INBOX',
    from: ERIN,
    to: [ME],
    subject: 'Re: 周三现场部署',
    body:
      '主人，按你昨天电话里说的，我已经联系了客户 IT，周三上午 9 点开始部署。' +
      '需要带的虚机镜像我下载好了。\n\n' +
      '另外，现场无 4G 信号，外网走客户 VPN——SSO 帐号你今天能发我吗？',
    ts: '2026-05-17T09:00:00+08:00',
    unread: true,
    messageId: '<onsite-r5@onsite.test>',
    // 指向一个我们 Sent 里没有的 message-id —— 用户那封是电话沟通，没有邮件。
    inReplyTo: '<phone-call-followup@nowhere>',
  },

  // ---------- Standalone 1: Newsletter (no parent, no reply) ----------
  {
    id: '106',
    folder: 'INBOX',
    from: NEWS,
    to: [ME],
    subject: 'InfoQ 周刊 · 第 31 期：Kubernetes 1.31 发布要点',
    body:
      '本周精选：\n\n' +
      '- Kubernetes 1.31 发布，重点改进 Cgroup v2 支持\n' +
      '- Rust 1.80 stable：异步 trait 终于稳定\n' +
      '- AWS re:Invent 提前预告：明年 12 月在 Las Vegas\n\n' +
      '订阅管理：unsubscribe@infoq.test',
    ts: '2026-05-17T08:00:00+08:00',
    unread: true,
    messageId: '<infoq-weekly-31@infoq.test>',
  },

  // ---------- Standalone 2: Alert (no parent, no reply) ----------
  {
    id: '107',
    folder: 'INBOX',
    from: ALERT,
    to: [ME],
    subject: '[ALERT P2] api-gateway 5xx rate 超过 0.5%（last 5m）',
    body:
      'Service: api-gateway\nRegion: ap-northeast-1\nMetric: http.5xx.rate\nValue: 0.62%\n' +
      'Threshold: 0.50%\nLast 5 min window starting 2026-05-17 11:35\n\n' +
      'Dashboard: https://datadoghq.test/dash/api-gw\n',
    ts: '2026-05-17T11:42:00+08:00',
    unread: true,
    messageId: '<alert-p2-api-gw-20260517-1142@datadoghq.test>',
  },

  // ---------- Thread 6: 长链 (你之前发了 → 对方回复 → 你又跟一封 → 对方再回 ) ----------
  // 测试 readEmail 一级 parent 解析在 chain 中段时的行为。
  {
    id: 'sent:6a',
    folder: 'SENT',
    from: ME,
    to: [FRANK],
    subject: '关于合作合同附件 3.2 条',
    body: 'Frank，关于合同附件第 3.2 条违约金那块，我们这边法务希望调整为 ...',
    ts: '2026-05-10T14:00:00+08:00',
    unread: false,
    messageId: '<contract-q6a@openmeido.test>',
  },
  {
    id: '108',  // Frank 的第一次回复，在 INBOX
    folder: 'INBOX',
    from: FRANK,
    to: [ME],
    subject: 'Re: 关于合作合同附件 3.2 条',
    body:
      '原则上可以接受，但 3.2 条调整后需要相应放开 3.3 条的赔偿上限。' +
      '附件是我们法务的反提案，麻烦看下。',
    ts: '2026-05-11T10:30:00+08:00',
    unread: false,
    messageId: '<contract-r6a@bigcorp.test>',
    inReplyTo: '<contract-q6a@openmeido.test>',
  },
  {
    id: 'sent:6b',  // 用户的二次跟进，也在 Sent
    folder: 'SENT',
    from: ME,
    to: [FRANK],
    subject: 'Re: Re: 关于合作合同附件 3.2 条',
    body:
      'Frank，反提案看了，3.3 条放开 50% 上限我们可以接受。但希望补一条 ' +
      '"赔偿不重复主张"，避免后面解释成本。',
    ts: '2026-05-13T09:00:00+08:00',
    unread: false,
    messageId: '<contract-q6b@openmeido.test>',
    inReplyTo: '<contract-r6a@bigcorp.test>',
  },
  {
    id: '109',  // Frank 的最终回复
    folder: 'INBOX',
    from: FRANK,
    to: [ME],
    subject: 'Re: Re: Re: 关于合作合同附件 3.2 条',
    body:
      '"不重复主张"OK，我们这就拟最终稿。预计周五下午发给双方法务做最后核对，' +
      '下周一签字仪式。地点和议程稍后单独发邮件。',
    ts: '2026-05-16T16:00:00+08:00',
    unread: true,
    messageId: '<contract-r6b@bigcorp.test>',
    inReplyTo: '<contract-q6b@openmeido.test>',
  },
]

const SNIPPET_LEN = 200

function snippetOf(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN)
}

function findByMessageId(messageId: string): FakeMail | undefined {
  return FAKE_DATA.find((m) => m.messageId === messageId)
}

function summaryOf(m: FakeMail, withParent = true): MailSummary {
  const result: MailSummary = {
    id: m.id,
    from: m.from,
    subject: m.subject,
    snippet: snippetOf(m.body),
    ts: m.ts,
    unread: m.unread,
    inReplyTo: m.inReplyTo,
  }
  if (withParent && m.inReplyTo) {
    const parent = findByMessageId(m.inReplyTo)
    if (parent) {
      result.parent = {
        id: parent.id,
        from: parent.from,
        subject: parent.subject,
        snippet: snippetOf(parent.body),
        ts: parent.ts,
        unread: parent.unread,
        inReplyTo: parent.inReplyTo,
      }
    } else {
      // We tried and didn't find — match the IMAP adapter's null-means-
      // "looked, not found" semantic.
      result.parent = null
    }
  }
  return result
}

function fullMessageOf(m: FakeMail, withParent = true): MailMessage {
  const result: MailMessage = {
    id: m.id,
    from: m.from,
    to: m.to,
    subject: m.subject,
    body: m.body,
    ts: m.ts,
    unread: m.unread,
    attachments: [],
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
  }
  if (withParent && m.inReplyTo) {
    const parent = findByMessageId(m.inReplyTo)
    if (parent) {
      result.parent = {
        id: parent.id,
        from: parent.from,
        to: parent.to,
        subject: parent.subject,
        body: parent.body,
        ts: parent.ts,
        unread: parent.unread,
        attachments: [],
        messageId: parent.messageId,
        inReplyTo: parent.inReplyTo,
        // No recursion — match IMAP adapter behavior.
      }
    } else {
      result.parent = null
    }
  }
  return result
}

export function createFakeMailAdapter(): MailAdapter {
  console.log(
    `[mail] using fake adapter (OPENMEIDO_FAKE_MAIL=1) — ${FAKE_DATA.length} synthetic messages loaded`,
  )

  return {
    async listInbox(o: ListInboxOptions): Promise<MailSummary[]> {
      // Filter to INBOX, sort newest first, slice to limit.
      const inbox = FAKE_DATA.filter((m) => m.folder === 'INBOX').sort((a, b) =>
        b.ts.localeCompare(a.ts),
      )
      const filtered = o.onlyUnread ? inbox.filter((m) => m.unread) : inbox
      const sliced = filtered.slice(0, o.limit)
      return sliced.map((m) => summaryOf(m, o.includeParents !== false))
    },

    async readMessage(id: string): Promise<MailMessage | null> {
      const m = FAKE_DATA.find((x) => x.id === id)
      if (!m) return null
      return fullMessageOf(m, true)
    },

    async listFolders() {
      // Synthetic folder set — mirrors what a 163 / Outlook user might
      // see. Enough variety for the model to practice picking the right
      // one when the user says "看看工作文件夹的邮件".
      return [
        { path: 'INBOX', name: 'INBOX', isInbox: true, isSpecialUse: false },
        { path: 'Sent', name: 'Sent', isInbox: false, isSpecialUse: true },
        { path: '工作', name: '工作', isInbox: false, isSpecialUse: false },
        { path: '重要', name: '重要', isInbox: false, isSpecialUse: false },
        { path: '账单', name: '账单', isInbox: false, isSpecialUse: false },
      ]
    },

    async testConnection() {
      return { ok: true }
    },

    async close() {
      // No-op; fake adapter holds no resources.
    },
  }
}
