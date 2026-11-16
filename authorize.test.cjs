'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const authorize = require('./authorize.cjs')

function createCtx() {
  const commands = []
  return {
    commands,
    command(def, desc) {
      const command = {
        def,
        desc,
        aliases: [],
        alias(name) { command.aliases.push(name); return command },
        action(handler) { command.handler = handler; return command },
      }
      commands.push(command)
      return command
    },
  }
}

function createLogger() {
  const logs = []
  return {
    logs,
    info: (...args) => logs.push(['info', args]),
    warn: (...args) => logs.push(['warn', args]),
  }
}

function createSession(platform = 'qq', sendResults = []) {
  const sent = []
  return {
    platform,
    sent,
    async send(content) {
      sent.push(content)
      const next = sendResults.length ? sendResults.shift() : ['ok']
      return next
    },
  }
}

const IMAGES = { authorize: Buffer.from('A'), manual: Buffer.from('M'), groupCode: Buffer.from('G') }

// 测试用的假机器人身份：插件本身不内置任何真实机器人 QQ 号 / UID
const FAKE_BOT_UIN = '1234567890'
const FAKE_BOT_UID = 'u_FAKEUID0123456789ab'

function setup(overrides = {}, images = IMAGES) {
  const ctx = createCtx()
  const logger = createLogger()
  const command = authorize.registerAuthorizeCommand(
    ctx,
    { authorize: { botUin: FAKE_BOT_UIN, botUid: FAKE_BOT_UID, ...overrides } },
    logger,
    { images },
  )
  return { ctx, logger, command }
}

function decodeUrl(url) {
  const parsed = new URL(url)
  return JSON.parse(parsed.searchParams.get('open_kuikly_info'))
}

function flatten(content) {
  const list = Array.isArray(content) ? content : [content]
  const out = []
  const walk = (node) => {
    if (!node) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === 'string') return out.push({ type: 'text', attrs: { content: node }, children: [] })
    out.push(node)
    ;(node.children || []).forEach(walk)
  }
  list.forEach(walk)
  return out
}

function textOf(content) {
  return flatten(content).filter((node) => node.type === 'text').map((node) => node.attrs.content).join('\n')
}

function buttons(content) {
  return flatten(content).filter((node) => node.type === 'button')
}

test('授权页地址：JSON 单行压缩后整体编码，数字字段为 number', () => {
  const url = authorize.buildTransferUrl({ groupCode: '100200300', botUin: FAKE_BOT_UIN, botUid: FAKE_BOT_UID })
  assert.ok(url.startsWith('https://club.vip.qq.com/transfer?open_kuikly_info=%7B%22page_name%22%3A%22ai_group_service_agreement_pop_page%22'))
  assert.deepEqual(decodeUrl(url), {
    page_name: 'ai_group_service_agreement_pop_page',
    groupCode: 100200300,
    botUin: Number(FAKE_BOT_UIN),
    botUid: FAKE_BOT_UID,
    screen: 1,
  })
  assert.ok(!url.includes(' '))
})

test('群号解析：去空白、全角转半角，拒绝非数字与越界长度', () => {
  assert.deepEqual(authorize.normalizeGroupCode(' 1234 5678 '), { ok: true, groupCode: '12345678' })
  assert.deepEqual(authorize.normalizeGroupCode('１２３４５６７８９'), { ok: true, groupCode: '123456789' })
  assert.deepEqual(authorize.normalizeGroupCode(undefined), { ok: false, reason: 'missing' })
  assert.deepEqual(authorize.normalizeGroupCode('   '), { ok: false, reason: 'missing' })
  assert.equal(authorize.normalizeGroupCode('群号123').reason, 'invalid')
  assert.equal(authorize.normalizeGroupCode('1234').reason, 'invalid')
  assert.equal(authorize.normalizeGroupCode('0123456').reason, 'invalid')
  assert.equal(authorize.normalizeGroupCode('1234567890123').reason, 'invalid')
})

test('插件不内置机器人身份：默认值留空，指令名为「授权全消息」、无权限限制', () => {
  const { ctx, command } = setup()
  assert.equal(ctx.commands.length, 1)
  assert.equal(command.def, '授权全消息 [groupCode:text]')
  assert.deepEqual(command.aliases, ['qqauth'])
  assert.equal(authorize.DEFAULT_BOT_UIN, '')
  assert.equal(authorize.DEFAULT_BOT_UID, '')
})

test('QQ 平台带群号：先发示意图与教程图，再发带授权 link 按钮的卡片', async () => {
  const { command } = setup()
  const session = createSession('qq')
  const output = await command.handler({ session }, '123456789')
  assert.equal(output, undefined)
  assert.equal(session.sent.length, 2)

  const images = flatten(session.sent[0]).filter((node) => node.type === 'img')
  assert.equal(images.length, 2)
  assert.equal(images[0].attrs.src, `data:image/png;base64,${IMAGES.authorize.toString('base64')}`)
  assert.equal(images[1].attrs.src, `data:image/png;base64,${IMAGES.manual.toString('base64')}`)

  const card = session.sent[1]
  const [link, retry] = buttons(card)
  assert.equal(link.attrs.type, 'link')
  assert.deepEqual(decodeUrl(link.attrs.href), {
    page_name: 'ai_group_service_agreement_pop_page',
    groupCode: 123456789,
    botUin: Number(FAKE_BOT_UIN),
    botUid: FAKE_BOT_UID,
    screen: 1,
  })
  assert.equal(retry.attrs.type, 'input')
  assert.equal(retry.attrs.text, '/授权全消息 ')
  // 正文不带链接，避免官方机器人裸链接被拦截
  assert.ok(!textOf(card).includes('https://'))
  assert.match(textOf(card), /群 123456789/)
})

test('QQ 平台缺群号：发群号教程图与「填写群号」按钮', async () => {
  const { command } = setup()
  const session = createSession('qq')
  await command.handler({ session }, undefined)
  assert.equal(session.sent.length, 2)
  const images = flatten(session.sent[0]).filter((node) => node.type === 'img')
  assert.deepEqual(images.map((node) => node.attrs.src), [`data:image/png;base64,${IMAGES.groupCode.toString('base64')}`])
  const [fill] = buttons(session.sent[1])
  assert.equal(fill.attrs.type, 'input')
  assert.equal(fill.attrs.text, '/授权全消息 ')
  assert.match(textOf(session.sent[1]), /授权全消息 123456789/)
})

test('群号格式错误时提示原输入', async () => {
  const { command } = setup()
  const session = createSession('qq')
  await command.handler({ session }, 'abc')
  assert.match(textOf(session.sent[1]), /「abc」不是有效的群号/)
})

test('按钮消息发送失败时改发纯文本兜底（不含链接）', async () => {
  const { command, logger } = setup()
  const session = createSession('qq', [['img'], [], ['fallback']])
  await command.handler({ session }, '123456789')
  assert.equal(session.sent.length, 3)
  assert.equal(typeof session.sent[2], 'string')
  assert.match(session.sent[2], /手动设置/)
  assert.ok(!session.sent[2].includes('https://'))
  assert.ok(logger.logs.some(([level]) => level === 'warn'))
})

test('非 QQ 平台：纯文本附授权页地址', async () => {
  const { command } = setup()
  const session = createSession('discord')
  await command.handler({ session }, '123456789')
  assert.equal(session.sent.length, 2)
  assert.equal(typeof session.sent[1], 'string')
  assert.match(session.sent[1], /授权页：https:\/\/club\.vip\.qq\.com\/transfer\?open_kuikly_info=/)
})

test('sendImages=false 时不发图片；图片缺失时跳过', async () => {
  const noImages = setup({ sendImages: false })
  const session = createSession('qq')
  await noImages.command.handler({ session }, '123456789')
  assert.equal(session.sent.length, 1)
  assert.equal(buttons(session.sent[0]).length, 2)

  const missing = setup({}, { manual: Buffer.from('M') })
  const session2 = createSession('qq')
  await missing.command.handler({ session: session2 }, '123456789')
  const images = flatten(session2.sent[0]).filter((node) => node.type === 'img')
  assert.equal(images.length, 1)
})

test('自定义指令名与输入前缀会同步到按钮预填内容', async () => {
  const { command } = setup({ command: '授权', inputPrefix: '!' })
  assert.equal(command.def, '授权 [groupCode:text]')
  const session = createSession('qq')
  await command.handler({ session }, '123456789')
  assert.equal(buttons(session.sent[1])[1].attrs.text, '!授权 ')
})

test('身份配置无效或缺失时拒绝生成；enabled=false 时不注册', async () => {
  const bad = setup({ botUin: 'abc' })
  const session = createSession('qq')
  const output = await bad.command.handler({ session }, '123456789')
  assert.match(output, /botUin 配置无效/)
  assert.equal(session.sent.length, 0)

  const missing = setup({ botUin: '', botUid: '' })
  const output2 = await missing.command.handler({ session: createSession('qq') }, '123456789')
  assert.match(output2, /botUin 未配置/)

  const disabled = setup({ enabled: false })
  assert.equal(disabled.command, undefined)
  assert.equal(disabled.ctx.commands.length, 0)
})

test('随插件打包的三张教程图都存在且是 PNG', () => {
  const images = authorize.loadImages(createLogger())
  for (const key of Object.keys(authorize.ASSETS)) {
    assert.ok(images[key], `缺少 ${key}`)
    assert.equal(images[key].subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  }
})
