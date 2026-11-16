'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const plugin = require('./index.cjs')

function fakeHttp(routes) {
  const calls = []
  const http = async (path, config = {}) => {
    const method = (config.method || 'GET').toUpperCase()
    calls.push({ path, method, data: config.data, params: config.params })
    const key = `${method} ${path}`
    const handler = routes[key]
    if (handler === undefined) {
      const error = new Error(`unexpected ${key}`)
      error.response = { status: 404, data: { err_code: 40400000, message: 'not found' } }
      throw error
    }
    return { data: typeof handler === 'function' ? handler(config) : handler }
  }
  http.calls = calls
  http.isError = (error) => Boolean(error && error.response)
  return http
}

function createCtx(bots, extra = {}) {
  const handlers = new Map()
  const commands = []
  const logs = []
  const ctx = {
    ...extra,
    bots,
    commands,
    logs,
    logger: () => ({
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      debug: () => {},
      error: () => {},
    }),
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
    },
    provide(name, value) { ctx[name] = value },
    command(name) {
      const command = {
        name,
        alias: () => command,
        userFields: () => command,
        action: (handler2) => { command.handler = handler2; return command },
      }
      commands.push(command)
      return command
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    emit: (name, ...args) => (handlers.get(name) || []).forEach((handler) => handler(...args)),
  }
  return ctx
}

function createBot(http, selfId = '1000000000000000001') {
  return { platform: 'qq', selfId, status: 1, internal: {}, http }
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    botSelfId: '',
    autoSync: false,
    dryRun: false,
    prune: false,
    allowEmptyMenu: false,
    remarkPrefix: 'koishi:',
    adminUserIds: [],
    manageAuthority: 4,
    menu: { items: [] },
    panels: [],
    ...overrides,
  }
}

function setup(routes, overrides = {}, extra = {}) {
  const http = fakeHttp(routes)
  const bot = createBot(http)
  const ctx = createCtx([bot], extra)
  plugin.apply(ctx, makeConfig(overrides))
  return { http, bot, ctx }
}

function writes(http) {
  return http.calls.filter((call) => call.method !== 'GET')
}

test('接口挂载到 bot.internal，且不覆盖适配器已有实现', async () => {
  const http = fakeHttp({})
  const bot = createBot(http)
  bot.internal.getMenu = async () => 'adapter-native'
  const ctx = createCtx([bot])
  plugin.apply(ctx, makeConfig())

  assert.equal(typeof bot.internal.updateMenu, 'function')
  assert.equal(typeof bot.internal.createPanel, 'function')
  assert.equal(typeof bot.internal.updatePanelTarget, 'function')
  assert.equal(await bot.internal.getMenu(), 'adapter-native')
  assert.equal(typeof ctx.qqMenuPanel.getMenu, 'function')
})

test('空配置：只读取平台现状，不产生任何写入', async () => {
  const { http, ctx } = setup({ 'GET /v2/menu': { version: 40, menu: {} } })
  const result = await ctx.qqMenuPanel.sync()

  assert.equal(result.menu.action, 'skipped')
  assert.equal(result.failures.length, 0)
  assert.deepEqual(writes(http), [])
  assert.deepEqual(http.calls.map((call) => `${call.method} ${call.path}`), ['GET /v2/menu'])
})

test('菜单：平台为空时按配置下发，内容一致后不再重复下发', async () => {
  const items = [{ type: 'send_message', name: '帮助', sendMessage: '!help' }]
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'PUT /v2/menu': { version: 41 },
  }, { menu: { items } })

  const first = await ctx.qqMenuPanel.sync({ resources: ['menu'] })
  assert.deepEqual(first.menu, { action: 'updated', version: 41, from: 0, to: 1 })
  assert.deepEqual(writes(http)[0].data, {
    menu: { items: [{ type: 'send_message', name: '帮助', send_message: '!help' }] },
  })

  const http2 = fakeHttp({ 'GET /v2/menu': { version: 41, menu: { items: [{ type: 'send_message', name: '帮助', send_message: '!help' }] } } })
  const bot2 = createBot(http2)
  const ctx2 = createCtx([bot2])
  plugin.apply(ctx2, makeConfig({ menu: { items } }))
  const second = await ctx2.qqMenuPanel.sync({ resources: ['menu'] })
  assert.equal(second.menu.action, 'unchanged')
  assert.deepEqual(writes(http2), [])
})

test('菜单：dryRun 只计算差异', async () => {
  const { http, ctx } = setup({ 'GET /v2/menu': { version: 40, menu: {} } }, {
    dryRun: true,
    menu: { items: [{ type: 'send_message', name: '帮助', sendMessage: '!help' }] },
  })
  const result = await ctx.qqMenuPanel.sync({ resources: ['menu'] })
  assert.equal(result.menu.action, 'dry-run')
  assert.deepEqual(writes(http), [])
})

test('面板：按配置创建，并带上备注与生效范围', async () => {
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { is_end: true },
    'POST /v2/panels': { panel_id: 'p_new' },
  }, {
    panels: [{
      key: 'group-sign',
      scope: 'group',
      targetType: 'specific',
      groupOpenIds: ['G1'],
      items: [{ type: 'command', name: '!签到', desc: '每日签到' }],
    }],
  })

  const result = await ctx.qqMenuPanel.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels, [{ action: 'created', key: 'group-sign', panelId: 'p_new' }])
  const post = writes(http).find((call) => call.method === 'POST')
  assert.deepEqual(post.data, {
    scope: 'group',
    target_type: 'specific',
    group_openids: ['G1'],
    panel: {
      items: [{ type: 'command', name: '!签到', desc: '每日签到', only_admin: false }],
      remark: 'koishi:group-sign',
    },
  })
})

test('面板：内容变化时更新，关联对象按差异增删', async () => {
  const record = {
    panel_id: 'p1',
    scope: 'group',
    target_type: 'specific',
    panel: { items: [{ type: 'command', name: '!old', only_admin: false }], remark: 'koishi:group-sign' },
    version: 3,
  }
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { records: [record], is_end: true },
    'GET /v2/panels/p1': { panel_id: 'p1', target_type: 'specific', group_openids: ['G1', 'G2'] },
    'PUT /v2/panels/p1': { version: 4 },
    'PUT /v2/panels/p1/target': {},
  }, {
    panels: [{
      key: 'group-sign',
      scope: 'group',
      targetType: 'specific',
      groupOpenIds: ['G2', 'G3'],
      items: [{ type: 'command', name: '!签到' }],
    }],
  })

  const result = await ctx.qqMenuPanel.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels.map((item) => item.action), ['updated', 'target-added', 'target-removed'])

  const targetCalls = writes(http).filter((call) => call.path === '/v2/panels/p1/target')
  assert.deepEqual(targetCalls.map((call) => call.data), [
    { op: 'add', group_openids: ['G3'] },
    { op: 'del', group_openids: ['G1'] },
  ])
  const updateCall = writes(http).find((call) => call.path === '/v2/panels/p1')
  assert.deepEqual(updateCall.data.panel.items, [{ type: 'command', name: '!签到', only_admin: false }])
})

test('prune：删除带前缀但配置已移除的面板，手工面板不动', async () => {
  const records = [
    { panel_id: 'p_gone', scope: 'c2c', target_type: 'all', panel: { items: [], remark: 'koishi:gone' } },
    { panel_id: 'p_manual', scope: 'c2c', target_type: 'all', panel: { items: [], remark: '手工配置' } },
  ]
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { records, is_end: true },
    'DELETE /v2/panels/p_gone': {},
  }, { prune: true })

  const result = await ctx.qqMenuPanel.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels, [{ action: 'deleted', key: 'koishi:gone', panelId: 'p_gone' }])
  assert.deepEqual(writes(http).map((call) => `${call.method} ${call.path}`), ['DELETE /v2/panels/p_gone'])
})

test('prune 关闭时不会删除任何面板', async () => {
  const records = [{ panel_id: 'p_gone', scope: 'c2c', target_type: 'all', panel: { items: [], remark: 'koishi:gone' } }]
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { records, is_end: true },
  })
  await ctx.qqMenuPanel.sync({ resources: ['panels'] })
  assert.deepEqual(writes(http), [])
})

test('配置非法时给出中文错误，且不发起写入', async () => {
  const { http, ctx } = setup({ 'GET /v2/menu': { version: 40, menu: {} } }, {
    menu: { items: [{ type: 'link', name: '官网', link: 'http://example.com' }] },
  })
  // 配置非法时直接抛出带中文说明的错误（指令层会转成“操作失败：…”，自动同步只记录警告）
  await assert.rejects(() => ctx.qqMenuPanel.sync({ resources: ['menu'] }), /https/)
  assert.deepEqual(writes(http), [])
})

test('平台返回错误码时报告失败但不中断其他动作', async () => {
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'PUT /v2/menu': () => {
      const error = new Error('Request failed with status code 400')
      error.response = { status: 400, data: { err_code: 40030020, message: '内容存在安全风险，请修改后重试' } }
      throw error
    },
  }, { menu: { items: [{ type: 'send_message', name: '帮助', sendMessage: '!help' }] } })

  const result = await ctx.qqMenuPanel.sync({ resources: ['menu'] })
  assert.equal(result.menu.action, 'failed')
  assert.match(result.failures[0], /40030020/)
})

test('管理指令：非管理员被拒绝，管理员可查看菜单', async () => {
  const { ctx } = setup({ 'GET /v2/menu': { version: 40, menu: {} } })

  const syncCommand = ctx.commands.find((command) => command.name === 'qqmenu.sync')
  const viewCommand = ctx.commands.find((command) => command.name === 'qqmenu')
  assert.ok(syncCommand && viewCommand)

  const denied = await syncCommand.handler({ session: { userId: 'U1', platform: 'qq', user: { authority: 0 } } })
  assert.match(denied, /没有管理/)

  const allowed = await viewCommand.handler({ session: { userId: 'U1', platform: 'qq', user: { authority: 0 } } })
  assert.match(allowed, /平台菜单版本 40/)

  const granted = await syncCommand.handler({ session: { userId: 'U1', platform: 'qq', user: { authority: 4 } } })
  assert.match(granted, /菜单/)
})

test('自动同步：机器人上线后只执行一次', async () => {
  const http = fakeHttp({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { is_end: true },
  })
  const bot = createBot(http)
  const ctx = createCtx([bot])
  plugin.apply(ctx, makeConfig({ autoSync: true }))

  ctx.emit('bot-status-updated', bot)
  await new Promise((resolve) => setTimeout(resolve, 30))
  ctx.emit('bot-status-updated', bot)
  await new Promise((resolve) => setTimeout(resolve, 30))

  const menuReads = http.calls.filter((call) => call.path === '/v2/menu')
  assert.equal(menuReads.length, 1)
})
test('限频：菜单写入失败后给出限频提示，面板剩余写操作跳过', async () => {
  const rateLimit = () => {
    const error = new Error('HTTP 400')
    error.response = { status: 400, data: { err_code: 40023001, message: '接口调用超过频率限制' } }
    throw error
  }
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'PUT /v2/menu': rateLimit,
    'GET /v2/panels': { is_end: true },
    'POST /v2/panels': rateLimit,
  }, {
    menu: { items: [{ type: 'send_message', name: '帮助', sendMessage: '!help' }] },
    panels: [
      { key: 'a', scope: 'c2c', items: [{ type: 'command', name: '!a' }] },
      { key: 'b', scope: 'c2c', items: [{ type: 'command', name: '!b' }] },
    ],
  })

  const result = await ctx.qqMenuPanel.sync()
  assert.equal(result.menu.action, 'failed')
  assert.match(result.warnings.join('\n'), /限频/)
  assert.deepEqual(result.panels.map((item) => item.action), ['failed', 'skipped'])
  assert.equal(http.calls.filter((call) => call.method === 'POST').length, 1)
})

test('作用范围/场景变化时删除并重建面板', async () => {
  const record = {
    panel_id: 'p_old',
    scope: 'c2c',
    target_type: 'all',
    panel: { items: [{ type: 'command', name: '!old', only_admin: false }], remark: 'koishi:sign' },
  }
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { records: [record], is_end: true },
    'DELETE /v2/panels/p_old': {},
    'POST /v2/panels': { panel_id: 'p_new' },
  }, {
    panels: [{ key: 'sign', scope: 'group', targetType: 'specific', groupOpenIds: ['G1'], items: [{ type: 'command', name: '!签到' }] }],
  })

  const result = await ctx.qqMenuPanel.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels.map((item) => item.action), ['recreated'])
  assert.deepEqual(writes(http).map((call) => `${call.method} ${call.path}`), ['DELETE /v2/panels/p_old', 'POST /v2/panels'])
})

test('source=commands：按 Koishi 命令注册表自动生成指令面板', async () => {
  const fakeCommand = (name, aliases, authority, hidden = false) => ({
    name,
    _aliases: aliases,
    children: [],
    config: { permissions: [`authority:${authority}`], slash: true, hidden },
  })
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { is_end: true },
    'POST /v2/panels': { panel_id: 'p_auto' },
  }, {
    panels: [{ key: 'c2c', scope: 'c2c' }],
  }, {
    $commander: {
      _commandList: [
        fakeCommand('raffle', { raffle: {}, '抽奖': {} }, 1),
        fakeCommand('raffle.create', { 'raffle.create': {}, '抽奖创建': {} }, 1),
        fakeCommand('mod', { mod: {} }, 3),
        fakeCommand('admin', { admin: {} }, 4),
        fakeCommand('qqpanel', { qqpanel: {} }, 1),
      ],
    },
    i18n: { get: (key) => ({ 'commands.raffle.description': 'QQ群关键词抽奖' }[key]) },
    root: { config: { prefix: ['!'] } },
  })

  const result = await ctx.qqMenuPanel.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels, [{ action: 'created', key: 'c2c', panelId: 'p_auto' }])
  assert.deepEqual(result.warnings, [])
  const post = writes(http).find((call) => call.method === 'POST')
  assert.deepEqual(post.data, {
    scope: 'c2c',
    target_type: 'all',
    panel: {
      items: [
        { type: 'command', name: '!抽奖', desc: 'QQ群关键词抽奖', only_admin: false },
        { type: 'command', name: '!mod', only_admin: true },
      ],
      remark: 'koishi:c2c',
    },
  })
})

test('source=manual：仍按手填 items 下发（向后兼容）', async () => {
  const { http, ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { is_end: true },
    'POST /v2/panels': { panel_id: 'p_manual' },
  }, {
    panels: [{
      key: 'c2c',
      scope: 'c2c',
      source: 'manual',
      items: [{ type: 'command', name: '!帮助', desc: '查看帮助' }],
    }],
  })
  const result = await ctx.qqMenuPanel.sync({ resources: ['panels'] })
  assert.deepEqual(result.panels, [{ action: 'created', key: 'c2c', panelId: 'p_manual' }])
  const post = writes(http).find((call) => call.method === 'POST')
  assert.equal(post.data.panel.items[0].name, '!帮助')
})

test('qqpanel 指令：输出自动生成的元素列表与差异', async () => {
  const command = { name: 'raffle', _aliases: { raffle: {}, '抽奖': {} }, children: [], config: { permissions: ['authority:1'], slash: true, hidden: false } }
  const { ctx } = setup({
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { is_end: true },
  }, {
    panels: [{ key: 'c2c', scope: 'c2c', source: 'commands' }],
  }, {
    $commander: { _commandList: [command] },
    i18n: { get: () => undefined },
    root: { config: { prefix: ['!'] } },
  })
  const view = ctx.commands.find((item) => item.name === 'qqpanel')
  assert.ok(view)
  const output = await view.handler({ session: { userId: 'U1', platform: 'qq', user: { authority: 0 } } })
  assert.match(output, /配置面板 c2c｜c2c｜all｜来源 commands｜1 项/)
  assert.match(output, /!抽奖/)
})

test('prefixMode：none 不带前缀、custom 用指定前缀、默认取 Koishi 的 prefix', async () => {
  const command = { name: 'raffle', _aliases: { raffle: {}, '抽奖': {} }, children: [], config: { permissions: ['authority:1'], slash: true, hidden: false } }
  const extra = {
    $commander: { _commandList: [command] },
    i18n: { get: () => undefined },
    root: { config: { prefix: ['!'] } },
  }
  const routes = {
    'GET /v2/menu': { version: 40, menu: {} },
    'GET /v2/panels': { is_end: true },
  }
  const labels = async (panel) => {
    const http = fakeHttp({ ...routes, 'POST /v2/panels': { panel_id: 'p_x' } })
    const bot = createBot(http)
    const ctx = createCtx([bot], extra)
    plugin.apply(ctx, makeConfig({ panels: [panel] }))
    await ctx.qqMenuPanel.sync({ resources: ['panels'] })
    const post = writes(http).find((call) => call.method === 'POST')
    return post.data.panel.items.map((item) => item.name)
  }
  assert.deepEqual(await labels({ key: 'k', scope: 'c2c', source: 'commands', prefixMode: 'none' }), ['抽奖'])
  assert.deepEqual(await labels({ key: 'k', scope: 'c2c', source: 'commands', prefixMode: 'custom', prefix: '/' }), ['/抽奖'])
  assert.deepEqual(await labels({ key: 'k', scope: 'c2c', source: 'commands' }), ['!抽奖'])
})

test('qqpanel.group：输出当前群 OpenID 与匹配的面板（需管理权限）', async () => {
  const { ctx } = setup({}, {
    panels: [
      { key: 'all-groups', scope: 'group', source: 'commands' },
      { key: 'celeste', scope: 'group', source: 'commands', targetType: 'specific', groupOpenIds: ['G1'] },
    ],
    adminUserIds: ['U1'],
  })
  const command = ctx.commands.find((item) => item.name === 'qqpanel.group')
  assert.ok(command)
  const denied = await command.handler({ session: { userId: 'U9', platform: 'qq', guildId: 'G1', isDirect: false, user: { authority: 0 } } })
  assert.match(denied, /没有管理/)
  const inside = await command.handler({ session: { userId: 'U1', platform: 'qq', guildId: 'G1', isDirect: false, user: { authority: 0 } } })
  assert.match(inside, /当前群 OpenID：G1/)
  assert.match(inside, /all-groups：全群生效/)
  assert.match(inside, /celeste：指定生效（含本群）/)
  const outside = await command.handler({ session: { userId: 'U1', platform: 'qq', guildId: 'G2', isDirect: false, user: { authority: 0 } } })
  assert.match(outside, /celeste：指定生效（不含本群）/)
})
