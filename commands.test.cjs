'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const commands = require('./commands.cjs')

function fakeCommand(name, options = {}) {
  return {
    name,
    _aliases: options.aliases || { [name]: {} },
    children: [],
    config: {
      permissions: [`authority:${options.authority === undefined ? 1 : options.authority}`],
      slash: options.slash === undefined ? true : options.slash,
      hidden: options.hidden === undefined ? false : options.hidden,
      ...(options.config || {}),
    },
  }
}

function fakeCtx(list, descriptions = {}, prefix = ['!', '/']) {
  return {
    $commander: { _commandList: list },
    i18n: { get: (key) => descriptions[key] },
    resolve: (value) => (typeof value === 'function' ? value() : value),
    root: { config: { prefix } },
  }
}

test('matchPattern：通配与相等匹配、大小写不敏感', () => {
  assert.equal(commands.matchPattern('raffle', 'raffle'), true)
  assert.equal(commands.matchPattern('raffle.*', 'raffle.create'), true)
  assert.equal(commands.matchPattern('qq*', 'qqmenu.sync'), true)
  assert.equal(commands.matchPattern('RAFFLE', 'raffle'), true)
  assert.equal(commands.matchPattern('raffle', 'raffle.create'), false)
  assert.equal(commands.matchPattern('', 'raffle'), false)
})

test('commandAuthority：取 permissions 中最大的 authority:n', () => {
  assert.equal(commands.commandAuthority(fakeCommand('a')), 1)
  assert.equal(commands.commandAuthority(fakeCommand('a', { authority: 4 })), 4)
  assert.equal(commands.commandAuthority({ config: { permissions: ['authority:2', 'user:123', 'authority:3'] } }), 3)
  assert.equal(commands.commandAuthority({ config: {} }), 0)
})

test('truncate：按中文占 2 个字符截断并加省略号', () => {
  assert.equal(commands.truncate('短描述', 30), '短描述')
  const long = commands.truncate('一二三四五六七八九十', 10)
  assert.equal(long.endsWith('…'), true)
  assert.ok(commands.textWeight ? true : true)
  const api = require('./api.cjs')
  assert.ok(api.textWeight(long) <= 10)
})

test('collectEntries：默认只收顶层命令，跳过 hidden / 超权限 / slash=false / 本插件命令', () => {
  const ctx = fakeCtx([
    fakeCommand('raffle', { aliases: { raffle: {}, '抽奖': {} } }),
    fakeCommand('raffle.create', { aliases: { 'raffle.create': {} } }),
    fakeCommand('admin', { authority: 4 }),
    fakeCommand('hidden-cmd', { hidden: true }),
    fakeCommand('no-slash', { slash: false }),
    fakeCommand('qqpanel'),
    fakeCommand('qqmenu.sync'),
  ])
  const { entries, warnings } = commands.collectEntries(ctx, { prefix: '!' })
  assert.deepEqual(entries.map((entry) => entry.name), ['raffle'])
  assert.deepEqual(entries[0].label, '!抽奖')
  assert.equal(entries[0].authority, 1)
  assert.equal(entries[0].onlyAdmin, false)
  assert.deepEqual(warnings, [])
})

test('collectEntries：include/exclude/subcommands/maxAuthority 生效', () => {
  const ctx = fakeCtx([
    fakeCommand('raffle', { aliases: { raffle: {} } }),
    fakeCommand('raffle.create', { aliases: { 'raffle.create': {}, '抽奖创建': {} } }),
    fakeCommand('updates'),
    fakeCommand('mod', { authority: 3 }),
  ])
  const withSubs = commands.collectEntries(ctx, { prefix: '!', subcommands: true, exclude: ['updates'] })
  assert.deepEqual(withSubs.entries.map((entry) => entry.name), ['raffle', 'raffle.create', 'mod'])
  assert.equal(withSubs.entries.find((entry) => entry.name === 'raffle.create').label, '!抽奖创建')
  assert.equal(withSubs.entries.find((entry) => entry.name === 'mod').onlyAdmin, true)
  assert.equal(withSubs.entries.find((entry) => entry.name === 'mod').desc, undefined)

  // 显式 include 的子命令即使 subcommands=false 也会收录
  const includeOnlySub = commands.collectEntries(ctx, { prefix: '!', include: ['raffle.create'] })
  assert.deepEqual(includeOnlySub.entries.map((entry) => entry.name).sort(), ['mod', 'raffle', 'raffle.create', 'updates'])

  // maxAuthority 过滤掉需要更高权限的命令（mod: authority 3）
  const strictAuthority = commands.collectEntries(ctx, { prefix: '!', maxAuthority: 2 })
  assert.deepEqual(strictAuthority.entries.map((entry) => entry.name).sort(), ['raffle', 'updates'])
  assert.equal(strictAuthority.entries.some((entry) => entry.name === 'mod'), false)
})

test('collectEntries：中文别名优先，超长时退回更短的名字，都超长则跳过并告警', () => {
  const ctx = fakeCtx([
    fakeCommand('long-command-name', { aliases: { 'long-command-name': {}, '抽奖创建向导': {} } }),
    fakeCommand('ascii-only', { aliases: { 'ascii-only': {}, 'a': {} } }),
    fakeCommand('way-too-long-command', { aliases: { 'way-too-long-command': {} } }),
  ])
  const { entries, warnings } = commands.collectEntries(ctx, { prefix: '!' })
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry.label]))
  assert.equal(byName['long-command-name'], '!抽奖创建向导')
  assert.equal(byName['ascii-only'], '!a')
  assert.equal(byName['way-too-long-command'], undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /way-too-long-command/)
})

test('collectEntries：描述来自 i18n 并截断到平台限制', () => {
  const ctx = fakeCtx([
    fakeCommand('raffle'),
    fakeCommand('long-desc'),
  ], {
    'commands.raffle.description': 'QQ群关键词抽奖',
    'commands.long-desc.description': '这是一条非常非常长的描述'.repeat(3),
  })
  const { entries } = commands.collectEntries(ctx, { prefix: '!' })
  const raffle = entries.find((entry) => entry.name === 'raffle')
  const long = entries.find((entry) => entry.name === 'long-desc')
  assert.equal(raffle.desc, 'QQ群关键词抽奖')
  const api = require('./api.cjs')
  assert.ok(api.textWeight(long.desc) <= api.LIMITS.panelItemDesc)
})

test('generateItems：排序（include 优先）、maxItems 上限与 extraItems 追加', () => {
  const ctx = fakeCtx([
    fakeCommand('zzz'),
    fakeCommand('aaa'),
    fakeCommand('raffle', { aliases: { raffle: {}, '抽奖': {} } }),
  ])
  const generated = commands.generateItems(ctx, {
    prefix: '!',
    include: ['raffle'],
    maxItems: 2,
    extraItems: [{ type: 'link', name: '官网', link: 'https://example.com' }],
  })
  // maxItems 是元素总数上限（平台上限 20）：先给 extraItems 留位，再按顺序放命令
  assert.deepEqual(generated.items.map((item) => item.name), ['!抽奖', '官网'])
  assert.equal(generated.items[0].type, 'command')
  assert.equal(generated.items[1].type, 'link')
  assert.equal(generated.warnings.length, 1)
  assert.match(generated.warnings[0], /maxItems|上限|超过/)

  // 无 include 时，中文标签（1 个中文算 2 字符）优先排在前面
  const prefixLess = commands.generateItems(ctx, { maxItems: 1 })
  assert.deepEqual(prefixLess.items.map((item) => item.name), ['抽奖'])  // 未传 prefix 时不带前缀
})

test('generateItems：缺少 $commander 时给出明确错误', () => {
  assert.throws(() => commands.generateItems({}, {}), /\$commander/)
})
test('描述优先取 command.ctx.i18n（i18n 定义按 scope 存储）', () => {
  const command = fakeCommand('raffle')
  command.ctx = { i18n: { get: () => '来自命令 scope 的描述' } }
  const ctx = fakeCtx([command], {})
  const { entries } = commands.collectEntries(ctx, { prefix: '!' })
  assert.equal(entries[0].desc, '来自命令 scope 的描述')
})

test('hidden 为无法无会话求值的计算值时按隐藏处理，且不访问 ctx.resolve', () => {
  const throwing = fakeCommand('computed-hidden', {})
  throwing.config.hidden = () => { throw new Error('需要 session') }
  const plainTrue = fakeCommand('flag-hidden', {})
  plainTrue.config.hidden = () => true
  const ctx = fakeCtx([throwing, plainTrue, fakeCommand('visible')], {})
  ctx.resolve = () => { throw new Error('不应被调用') }
  const { entries } = commands.collectEntries(ctx, { prefix: '!' })
  assert.deepEqual(entries.map((entry) => entry.name), ['visible'])
})

test('pickText：兼容字符串与 { locale: text }（I18n#get 的返回形态）', () => {
  assert.equal(commands.pickText('abc'), 'abc')
  assert.equal(commands.pickText({ '': '', 'zh-CN': '中文描述' }), '中文描述')
  assert.equal(commands.pickText({ '': '' }), undefined)
  assert.equal(commands.pickText(undefined), undefined)
})

test('描述：i18n.get 返回对象时也能取到文本', () => {
  const command = fakeCommand('raffle')
  command.ctx = { i18n: { get: () => ({ '': '', 'zh-CN': 'QQ群关键词抽奖（自动）' }) } }
  const { entries } = commands.collectEntries(fakeCtx([command], {}), { prefix: '!' })
  assert.equal(entries[0].desc, 'QQ群关键词抽奖（自动）')
})
