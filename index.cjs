'use strict'

/**
 * koishi-plugin-qq-menu-panel
 *
 * QQ 官方机器人「自定义菜单」（/v2/menu，仅 C2C 单聊）与「指令面板」
 * （/v2/panels，c2c/group/channel/dm）适配：
 *
 * 1. 在配置里声明菜单项与面板，机器人上线后自动与平台对齐；内容一致时不发请求，
 *    不会反复刷新平台版本号，也不会误删平台手工配置的内容（prune 默认关闭）。
 * 2. 把 getMenu/updateMenu/getPanels/createPanel/getPanel/updatePanel/deletePanel/
 *    updatePanelTarget 挂到 QQ 机器人的 bot.internal 上（若适配器将来原生支持同名方法
 *    则不覆盖），并提供 ctx.qqMenuPanel 服务，供其他插件调用。
 * 3. 提供 qqmenu / qqpanel / qqsync 管理指令用于现场查看与手动下发。
 *
 * 请求全部通过 QQ 适配器的 bot.http 发出，复用适配器 endpoint 与 access_token，
 * 插件本身不保存任何凭据。
 */

const { Schema } = require('koishi')
const api = require('./api.cjs')
const sync = require('./sync.cjs')
const commands = require('./commands.cjs')
const authorize = require('./authorize.cjs')

exports.name = 'qq-menu-panel'

exports.usage = [
  'QQ 机器人自定义菜单与指令面板适配。',
  '配置中声明 menu.items 与 panels 后自动与平台对齐；',
  '管理指令：qqmenu（查看菜单）、qqmenu.sync（下发菜单）、qqpanel（列表面板）、',
  'qqpanel.sync（下发面板）、qqpanel.delete <panel_id>（删除面板）、qqsync（同时下发）。',
  '群主授权：任何群成员发送 /授权全消息 <群号>，机器人回复授权按钮与教程图，由群主点开授权「获取群内全部消息 + 主动发言」。',
].join('\n')

/* ------------------------------------------------------------------ 配置 schema */

const menuItemSchema = Schema.object({
  type: Schema.union(api.MENU_ITEM_TYPES).default('send_message')
    .description('按钮类型：switch 开关 / send_message 发送消息 / link 链接跳转 / menu 折叠子菜单'),
  name: Schema.string().description('按钮名称，最多 10 个字符（一个中文汉字算 2 个）'),
  sendMessage: Schema.string().description('type=send_message：点击后自动填入聊天输入框的内容'),
  link: Schema.string().description('type=link：跳转地址，必须以 https:// 开头'),
  switchId: Schema.string().description('type=switch：开关标识，用户切换状态后会带上该字段'),
  switchDefault: Schema.boolean().description('type=switch：默认是否打开'),
  subMenuItems: Schema.array(Schema.object({
    type: Schema.union(api.SUB_MENU_ITEM_TYPES).default('send_message').description('子菜单类型，不支持再嵌套 menu'),
    name: Schema.string().description('子菜单名称，最多 14 个字符（约 7 个中文汉字）'),
    sendMessage: Schema.string().description('type=send_message：点击后填入聊天输入框的内容'),
    link: Schema.string().description('type=link：跳转地址，必须以 https:// 开头'),
  })).description('type=menu：子菜单列表，最多 5 个'),
})

const panelItemSchema = Schema.object({
  type: Schema.union(api.PANEL_ITEM_TYPES).default('command')
    .description('元素类型：command 指令（点击后填入输入框）/ link 链接跳转'),
  name: Schema.string().description('元素名称；type=command 时同时是点击后填入输入框的内容（最多 14 个字符）'),
  desc: Schema.string().description('元素描述，最多 30 个字符（约 15 个中文汉字）'),
  link: Schema.string().description('type=link：跳转地址，必须以 https:// 开头'),
  onlyAdmin: Schema.boolean().default(false).description('是否仅频道/群管理员可点击'),
})

const panelSchema = Schema.object({
  key: Schema.string().required()
    .description('本地标识：默认用它生成面板备注 koishi:<key>，并据此匹配平台上的面板'),
  scope: Schema.union(api.PANEL_SCOPES).default('c2c')
    .description('生效场景：c2c 单聊 / group 群聊 / channel 文字子频道 / dm 频道私信'),
  targetType: Schema.union(api.PANEL_TARGET_TYPES).default('all')
    .description('作用范围：all 对该场景全部用户/群生效；specific 仅对指定用户/群生效（仅 c2c/group）'),
  userOpenIds: Schema.array(String).default([])
    .description('scope=c2c 且 targetType=specific 时的用户 openid，一次最多 20 个，后续差异会自动增删'),
  groupOpenIds: Schema.array(String).default([])
    .description('scope=group 且 targetType=specific 时的群 openid，一次最多 20 个，后续差异会自动增删'),
  panelId: Schema.string()
    .description('已存在的远端 panel_id；填写后按 ID 绑定，不再按备注匹配'),
  remark: Schema.string()
    .description('平台侧备注（默认 koishi:<key>，同时是匹配远端面板的依据）'),
  source: Schema.union(['commands', 'manual']).default('commands')
    .description('内容来源：commands 自动按 Koishi 命令注册表生成（默认）；manual 使用下面的 items'),
  include: Schema.array(String).default([])
    .description('source=commands：命中的命令优先展示（支持 * 通配，如 raffle.*）；显式列出的子命令也会包含'),
  exclude: Schema.array(String).default([])
    .description('source=commands：排除的命令（支持 * 通配）；默认已排除本插件的 qqmenu*/qqpanel*/qqsync'),
  subcommands: Schema.boolean().default(false)
    .description('source=commands：是否收录子命令（例如 raffle.create）'),
  maxAuthority: Schema.number().min(0).max(5).default(3)
    .description('source=commands：只收录最低权限等级不超过该值的命令'),
  adminAuthority: Schema.number().min(0).max(5).default(3)
    .description('source=commands：权限等级 ≥ 该值的命令标记为「仅频道/群管理员可点击」'),
  maxItems: Schema.number().min(1).max(api.LIMITS.panelItems).default(api.LIMITS.panelItems)
    .description('元素数量上限（平台上限 20）'),
  prefixMode: Schema.union(['koishi', 'custom', 'none']).default('koishi')
    .description('命令前缀：koishi 用 Koishi 的 prefix 配置；custom 用下面的 prefix；none 不带前缀（只写命令名）'),
  prefix: Schema.string().default('')
    .description('prefixMode=custom 时使用的前缀'),
  extraItems: Schema.array(panelItemSchema).default([])
    .description('source=commands：自动生成之外再追加的元素（链接等）'),
  items: Schema.array(panelItemSchema).default([])
    .description('source=manual 时使用的元素列表，最多 20 个'),
})

exports.Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用插件；关闭后不注册指令也不挂载接口'),
  botSelfId: Schema.string().default('').description('限定机器人 selfId；留空表示对所有 platform=qq 的机器人生效'),
  autoSync: Schema.boolean().default(true).description('机器人上线后按配置自动对齐平台；内容一致时不会提交请求'),
  dryRun: Schema.boolean().default(false).description('演练模式：只计算并打印差异，不向平台提交任何修改'),
  prune: Schema.boolean().default(false).description('删除平台带有备注前缀、但配置中已移除的面板（默认关闭，避免误删）'),
  allowEmptyMenu: Schema.boolean().default(false).description('配置里菜单为空时也下发空菜单（会清空平台现有菜单，默认关闭）'),
  remarkPrefix: Schema.string().default('koishi:').description('面板备注前缀，用于识别由本插件管理的面板'),
  adminUserIds: Schema.array(String).default([]).description('可执行管理指令的用户 ID，支持 userId 或 platform:userId'),
  manageAuthority: Schema.number().min(0).max(5).default(4).description('未列入 adminUserIds 时执行管理指令所需的最低权限等级'),
  menu: Schema.object({
    items: Schema.array(menuItemSchema).default([]).description('自定义菜单项，最多 10 个；仅 C2C 单聊生效'),
  }).description('自定义菜单；下发会完整覆盖平台上的菜单配置'),
  panels: Schema.array(panelSchema).default([]).description('指令面板，单个机器人最多 20 个'),
  authorize: Schema.object({
    enabled: Schema.boolean().default(true).description('注册群主授权指令'),
    command: Schema.string().default(authorize.DEFAULT_COMMAND).description('指令名（修改后需重载插件）'),
    botUin: Schema.string().default(authorize.DEFAULT_BOT_UIN)
      .description('本机器人的 QQ 号（授权页 botUin）；插件不内置任何机器人身份，必须自行填写，查看方法见 README'),
    botUid: Schema.string().default(authorize.DEFAULT_BOT_UID)
      .description('本机器人的 UID（授权页 botUid，u_ 开头）；必须与 botUin 对应同一个机器人，查看方法见 README'),
    inputPrefix: Schema.string().default('/').description('「填写群号」按钮预填到输入框的指令前缀'),
    sendImages: Schema.boolean().default(true).description('随回复发送授权示意图与教程图'),
  }).description('群主授权「获取群内全部消息 + 主动发言」：所有群成员可触发，参数为群号'),
})

/* ------------------------------------------------------------------ 插件实现 */

// 挂载到 bot.internal 的方法名；这些方法会以 bot 作为最后一个参数调用服务。
const API_METHODS = [
  'getMenu', 'updateMenu', 'getPanels', 'getAllPanels', 'createPanel',
  'getPanel', 'updatePanel', 'deletePanel', 'updatePanelTarget',
]

// Universal.Status.ONLINE === 1
const STATUS_ONLINE = 1

const ACTION_LABELS = {
  created: '新建',
  updated: '更新',
  unchanged: '无需修改',
  recreated: '重建',
  deleted: '删除',
  'target-added': '补充关联对象',
  'target-removed': '移除关联对象',
  skipped: '跳过',
  failed: '失败',
}

exports.apply = (ctx, config) => {
  if (config.enabled === false) {
    ctx.logger('qq-menu-panel').info('插件已通过配置禁用，未注册任何指令与接口')
    return
  }

  const logger = ctx.logger('qq-menu-panel')
  const autoSynced = new Set()
  let disposed = false
  ctx.on('dispose', () => { disposed = true })

  function bots() {
    return ctx.bots.filter((bot) => bot && bot.platform === 'qq'
      && (!config.botSelfId || bot.selfId === config.botSelfId))
  }

  function onlineBots() {
    return bots().filter((bot) => bot.status === STATUS_ONLINE)
  }

  function requireBot(bot) {
    if (bot) return bot
    const online = onlineBots()
    if (!online.length) throw new Error('没有在线的 QQ 机器人：适配器上线后菜单/面板接口才可用')
    return online[0]
  }

  /** 校验配置里的菜单（返回平台形态）。 */
  function desiredMenu() {
    return api.normalizeMenu(config.menu)
  }

  /** 默认命令前缀：优先面板自身配置，其次 Koishi 根配置的 prefix。 */
  function defaultPrefix() {
    const rootConfig = (ctx.root && ctx.root.config) || {}
    const list = rootConfig.prefix
    if (Array.isArray(list) && list.length) return String(list[0])
    if (typeof list === 'string' && list) return list
    return '!'
  }

  /** 面板元素前缀：koishi（默认）取 Koishi 的 prefix；custom 用配置值；none 不带前缀。 */
  function resolvePrefix(input) {
    const mode = (input && input.prefixMode) || 'koishi'
    if (mode === 'none') return ''
    if (mode === 'custom') return typeof input.prefix === 'string' ? input.prefix : ''
    return defaultPrefix()
  }

  /** 解析单个面板的元素；source=commands 时按命令注册表自动生成。 */
  function resolvePanelItems(input, index, warnings) {
    const source = input && (input.source === 'manual' || input.source === 'commands')
      ? input.source
      : (Array.isArray(input && input.items) && input.items.length ? 'manual' : 'commands')
    if (source === 'manual') return { source, items: (input && input.items) || [] }
    const prefix = resolvePrefix(input)
    const generated = commands.generateItems(ctx, { ...input, prefix })
    for (const warning of generated.warnings) {
      warnings.push(`面板 #${index + 1}（${input.key || input.scope}）：${warning}`)
    }
    return { source, items: generated.items }
  }

  /** 校验配置里的面板（返回平台形态 + 本地 key/备注）。 */
  function desiredPanels() {
    const remarks = new Set()
    const panelIds = new Set()
    const warnings = []
    const panels = config.panels.map((item, index) => {
      const resolved = resolvePanelItems(item, index, warnings)
      const panel = sync.normalizePanelConfig(item, index, { remarkPrefix: config.remarkPrefix, items: resolved.items })
      panel.source = resolved.source
      if (remarks.has(panel.remark)) throw new Error(`面板 #${index + 1} 的备注与前面的面板重复：${panel.remark}`)
      remarks.add(panel.remark)
      if (panel.panelId) {
        if (panelIds.has(panel.panelId)) throw new Error(`面板 #${index + 1} 绑定了重复的 panel_id：${panel.panelId}`)
        panelIds.add(panel.panelId)
      }
      return panel
    })
    return { panels, warnings }
  }

  const service = {
    bots: () => bots(),
    onlineBots: () => onlineBots(),
    getMenu: (bot) => api.getMenu(requireBot(bot).http),
    updateMenu: (menu, bot) => api.updateMenu(requireBot(bot).http, menu),
    getPanels: (params, bot) => api.getPanels(requireBot(bot).http, params),
    getAllPanels: (scope, bot) => api.getAllPanels(requireBot(bot).http, scope),
    createPanel: (input, bot) => api.createPanel(requireBot(bot).http, input),
    getPanel: (panelId, bot) => api.getPanel(requireBot(bot).http, panelId),
    updatePanel: (panelId, panel, bot) => api.updatePanel(requireBot(bot).http, panelId, panel),
    deletePanel: (panelId, bot) => api.deletePanel(requireBot(bot).http, panelId),
    updatePanelTarget: (panelId, input, bot) => api.updatePanelTarget(requireBot(bot).http, panelId, input),
    inspect: (options) => inspect(options),
    sync: (options) => syncAll(options),
  }
  ctx.provide('qqMenuPanel', service)

  /** 只读取平台现状并计算差异，不做任何修改。 */
  async function inspect(options = {}) {
    const bot = requireBot(options.bot)
    const menu = desiredMenu()
    const desired = desiredPanels()
    const panels = desired.panels
    const report = { selfId: bot.selfId, menu: null, panels: [], desired: [], records: [], warnings: desired.warnings.slice(0) }

    const remoteMenu = await api.getMenu(bot.http)
    report.menu = {
      remote: remoteMenu,
      desired: menu,
      managed: menu.items.length > 0 || Boolean(config.allowEmptyMenu),
      plan: sync.planMenu(remoteMenu, menu),
    }

    const scopes = new Set(panels.map((panel) => panel.scope))
    if (config.prune) for (const scope of api.PANEL_SCOPES) scopes.add(scope)
    const records = []
    const seenRecords = new Set()
    for (const scope of scopes) {
      for (const record of await api.getAllPanels(bot.http, scope)) {
        if (!record || !record.panel_id || seenRecords.has(record.panel_id)) continue
        seenRecords.add(record.panel_id)
        records.push(record)
      }
    }
    const matches = sync.matchPanels(panels, records)
    const details = new Map()
    for (const { panel, record } of matches) {
      if (!record || panel.targetType !== 'specific' || record.target_type !== 'specific') continue
      if (details.has(record.panel_id)) continue
      details.set(record.panel_id, await api.getPanel(bot.http, record.panel_id))
    }
    report.records = records
    report.desired = panels.map((panel) => ({
      key: panel.key,
      scope: panel.scope,
      targetType: panel.targetType,
      source: panel.source,
      remark: panel.remark,
      labels: panel.panel.items.map((entry) => (entry.type === 'link' ? `${entry.name}（${entry.link}）` : entry.name)),
    }))
    report.panels = sync.planPanels({
      matches,
      details,
      records,
      remarkPrefix: config.remarkPrefix,
      prune: Boolean(config.prune),
    })
    return report
  }

  /** 读取现状、计算差异并按需下发。resources 可限定为 ['menu'] 或 ['panels']。 */
  async function syncAll(options = {}) {
    const bot = requireBot(options.bot)
    const dryRun = options.dryRun === undefined ? Boolean(config.dryRun) : Boolean(options.dryRun)
    const resources = options.resources || ['menu', 'panels']
    const report = await inspect({ bot })
    const result = { selfId: bot.selfId, dryRun, menu: null, panels: [], warnings: report.warnings.slice(0), failures: [] }

    if (resources.includes('menu')) {
      const info = report.menu
      if (!info.managed) {
        result.menu = { action: 'skipped', version: info.remote.version, reason: '配置未提供菜单项且 allowEmptyMenu=false，未改动平台菜单' }
      } else if (!info.plan.changed) {
        result.menu = { action: 'unchanged', version: info.remote.version, itemCount: info.plan.desiredItemCount }
      } else if (dryRun) {
        result.menu = { action: 'dry-run', version: info.remote.version, from: info.plan.remoteItemCount, to: info.plan.desiredItemCount }
      } else {
        try {
          const updated = await api.updateMenu(bot.http, info.desired)
          result.menu = { action: 'updated', version: updated.version, from: info.plan.remoteItemCount, to: info.plan.desiredItemCount }
          logger.info('QQ 自定义菜单已更新：%d -> %d 项，版本 %s', info.plan.remoteItemCount, info.plan.desiredItemCount, updated.version)
        } catch (error) {
          const message = api.describeError(error)
          result.menu = { action: 'failed', error: message }
          result.failures.push(`菜单下发失败：${message}`)
          if (api.isRateLimited(error)) result.warnings.push('平台对菜单写入限频（5 次/分钟），稍后再同步即可')
        }
      }
    }

    if (resources.includes('panels')) {
      let panelWriteBlocked = false
      for (const action of report.panels) {
        const panelKey = action.panel ? action.panel.key : action.remark
        if (panelWriteBlocked && action.type !== 'unchanged' && action.type !== 'warn') {
          result.panels.push({ action: 'skipped', key: panelKey, panelId: action.panelId, reason: '平台限频' })
          continue
        }
        if (action.type === 'unchanged') {
          result.panels.push({ action: 'unchanged', key: panelKey, panelId: action.panelId })
          continue
        }
        if (action.type === 'warn') {
          result.panels.push({ action: 'skipped', key: panelKey, panelId: action.panelId })
          result.warnings.push(action.message)
          continue
        }
        if (dryRun) {
          result.panels.push({ action: 'dry-run', type: action.type, key: panelKey, panelId: action.panelId })
          continue
        }
        try {
          if (action.type === 'create' || action.type === 'recreate') {
            if (action.type === 'recreate') {
              await api.deletePanel(bot.http, action.panelId)
            }
            const payload = {
              scope: action.panel.scope,
              target_type: action.panel.targetType,
              panel: action.panel.panel,
            }
            if (action.panel.userOpenIds.length) payload.user_openids = action.panel.userOpenIds
            if (action.panel.groupOpenIds.length) payload.group_openids = action.panel.groupOpenIds
            const created = await api.createPanel(bot.http, payload)
            const entry = {
              action: action.type === 'recreate' ? 'recreated' : 'created',
              key: action.panel.key,
              panelId: created.panelId,
            }
            if (action.reason) entry.reason = action.reason
            result.panels.push(entry)
            logger.info('QQ 指令面板已%s：%s -> %s（%s，%d 项：%s）', action.type === 'recreate' ? '重建' : '创建', action.panel.key, created.panelId, action.panel.scope, action.panel.panel.items.length, summarizeItems(action.panel.panel.items))
          } else if (action.type === 'update') {
            await api.updatePanel(bot.http, action.panelId, action.panel.panel)
            result.panels.push({ action: 'updated', key: action.panel.key, panelId: action.panelId })
            logger.info('QQ 指令面板已更新：%s -> %s（%d 项：%s）', action.panel.key, action.panelId, action.panel.panel.items.length, summarizeItems(action.panel.panel.items))
          } else if (action.type === 'target') {
            const field = action.scope === 'group' ? 'group_openids' : 'user_openids'
            await api.updatePanelTarget(bot.http, action.panelId, { op: action.op, [field]: action.openIds })
            result.panels.push({
              action: action.op === 'add' ? 'target-added' : 'target-removed',
              key: panelKey,
              panelId: action.panelId,
              count: action.openIds.length,
            })
            logger.info('QQ 指令面板 %s 关联对象已%s %d 个', action.panelId, action.op === 'add' ? '补充' : '移除', action.openIds.length)
          } else if (action.type === 'delete') {
            await api.deletePanel(bot.http, action.panelId)
            result.panels.push({ action: 'deleted', key: panelKey, panelId: action.panelId })
            logger.info('QQ 指令面板已删除：%s（%s）', action.panelId, action.remark)
          }
        } catch (error) {
          const message = api.describeError(error)
          result.panels.push({ action: 'failed', type: action.type, key: panelKey, panelId: action.panelId, error: message })
          result.failures.push(`${action.type} ${panelKey} 失败：${message}`)
          logger.warn('QQ 菜单/面板同步动作失败（%s %s）：%s', action.type, panelKey, message)
          if (api.isRateLimited(error) && !panelWriteBlocked) {
            panelWriteBlocked = true
            result.warnings.push('平台对面板写入限频（10 次/分钟），本次剩余动作已跳过，请稍后再同步')
          }
        }
      }
    }

    return result
  }

  /** 把接口挂到适配器实例上；适配器将来若原生支持同名方法则保持原生实现。 */
  function attach(bot) {
    if (!bot || bot.platform !== 'qq' || !bot.internal) return
    const attached = []
    for (const name of API_METHODS) {
      if (typeof bot.internal[name] === 'function') continue
      bot.internal[name] = (...args) => service[name](...args, bot)
      attached.push(name)
    }
    if (attached.length) logger.info('已挂载 QQ 菜单/面板接口到机器人 %s：%s', bot.selfId || '(尚未识别)', attached.join(', '))
  }

  function describePanelItem(item) {
    if (item.type === 'link') return `${item.name}(${item.link})`
    return item.name + (item.desc ? `(${item.desc})` : '')
  }

  function describeMenu(menu) {
    const items = (menu && menu.items) || []
    if (!items.length) return '（平台当前没有菜单项）'
    return items.map((item, index) => {
      const extra = item.type === 'send_message' ? item.send_message
        : item.type === 'link' ? item.link
          : item.type === 'switch' ? `switch_id=${item.switch && item.switch.switch_id}`
            : `${(item.sub_menu_items || []).length} 个子项`
      return `${index + 1}. [${item.type}] ${item.name}${extra ? ` → ${extra}` : ''}`
    }).join('\n')
  }

/** 面板元素摘要：命令名或链接。 */
  function summarizeItems(items) {
    return (items || []).map((entry) => (entry.type === 'link' ? `${entry.name}（${entry.link}）` : entry.name)).join('、')
  }

  function describePanels(records) {
    if (!records.length) return '（平台当前没有已生效的指令面板）'
    return records.map((record) => {
      const items = (record.panel && record.panel.items) || []
      const remark = (record.panel && record.panel.remark) || '-'
      return `${record.panel_id}｜${record.scope}｜${record.target_type}｜${items.length} 项｜v${record.version ?? '-'}｜${remark}`
    }).join('\n')
  }

  function formatResult(result) {
    const lines = []
    if (result.dryRun) lines.push('（演练模式：未向平台提交任何修改）')
    if (result.menu) {
      const info = result.menu
      if (info.action === 'unchanged') lines.push(`菜单：无需修改（${info.itemCount} 项，版本 ${info.version}）`)
      else if (info.action === 'skipped') lines.push(`菜单：跳过（${info.reason}）`)
      else if (info.action === 'dry-run') lines.push(`菜单：待更新（${info.from} -> ${info.to} 项，当前版本 ${info.version}）`)
      else if (info.action === 'updated') lines.push(`菜单：已更新（${info.from} -> ${info.to} 项，版本 ${info.version}）`)
      else lines.push(`菜单：失败（${info.error}）`)
    }
    const counts = new Map()
    for (const item of result.panels) {
      const key = item.action.startsWith('dry-run') ? `演练:${ACTION_LABELS[item.type] || item.type || ''}` : (ACTION_LABELS[item.action] || item.action)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    if (counts.size) lines.push(`面板：${[...counts].map(([key, value]) => `${key} ${value}`).join('、')}`)
    else lines.push('面板：配置中没有需要同步的面板')
    for (const warning of result.warnings) lines.push(`警告：${warning}`)
    for (const failure of result.failures) lines.push(`失败：${failure}`)
    return lines.join('\n')
  }

  function isManager(session) {
    if (!session) return false
    const ids = [session.userId, session.platform && `${session.platform}:${session.userId}`].filter(Boolean)
    if (ids.some((id) => (config.adminUserIds || []).includes(id))) return true
    return Number((session.user && session.user.authority) || 0) >= config.manageAuthority
  }

  async function run(handler) {
    try {
      return await handler()
    } catch (error) {
      return `操作失败：${api.describeError(error)}`
    }
  }

  ctx.command('qqmenu', '查看 QQ 自定义菜单与配置差异')
    .alias('qq菜单')
    .action(({ session }) => run(async () => {
      const bot = requireBot()
      const remote = await api.getMenu(bot.http)
      const desired = desiredMenu()
      const plan = sync.planMenu(remote, desired)
      const lines = [
        `机器人 ${bot.selfId}｜平台菜单版本 ${remote.version}，当前 ${((remote.menu && remote.menu.items) || []).length} 项`,
        describeMenu(remote.menu),
      ]
      if (!desired.items.length && !config.allowEmptyMenu) lines.push('配置未提供菜单项（allowEmptyMenu=false），不会改动平台菜单')
      else if (!plan.changed) lines.push(`配置与平台一致（${plan.desiredItemCount} 项），无需下发`)
      else lines.push(`配置与平台不一致：${plan.remoteItemCount} -> ${plan.desiredItemCount} 项，可用 qqmenu.sync 下发`)
      return lines.join('\n')
    }))

  ctx.command('qqmenu.sync', '按配置下发 QQ 自定义菜单')
    .alias('qq菜单同步')
    .userFields(['authority'])
    .action(({ session }) => {
      if (!isManager(session)) return '你没有管理 QQ 菜单/面板的权限。'
      return run(async () => formatResult(await syncAll({ resources: ['menu'] })))
    })

  ctx.command('qqpanel', '列出 QQ 指令面板与配置差异')
    .alias('qq面板')
    .action(({ session }) => run(async () => {
      const report = await inspect()
      const lines = [`机器人 ${report.selfId}｜平台生效面板 ${report.records.length} 个`, describePanels(report.records)]
      if (!report.desired.length) lines.push('配置中没有面板（可在控制台添加 c2c/group/channel/dm 面板）')
      for (const panel of report.desired) {
        lines.push(`配置面板 ${panel.key}｜${panel.scope}｜${panel.targetType}｜来源 ${panel.source}｜${panel.labels.length} 项`)
        if (panel.labels.length) lines.push(panel.labels.join('、'))
      }
      const pending = report.panels.filter((action) => action.type !== 'unchanged' && action.type !== 'warn')
      if (!pending.length) lines.push('配置与平台一致，无需下发')
      else lines.push(`待处理动作 ${pending.length} 个：${pending.map((action) => action.type).join('、')}（用 qqpanel.sync 下发）`)
      for (const warning of report.warnings) lines.push(`警告：${warning}`)
      return lines.join('\n')
    }))

  ctx.command('qqpanel.group', '查看当前群的 OpenID 与匹配的指令面板')
    .alias('面板群号')
    .userFields(['authority'])
    .action(({ session }) => {
      if (!isManager(session)) return '你没有管理 QQ 菜单/面板的权限。'
      return run(async () => {
        if (!session || session.isDirect) return '请在目标 QQ 群里使用该命令。'
        const openId = session.guildId || session.channelId
        const lines = [`当前群 OpenID：${openId}`]
        const panels = config.panels.filter((item) => (item.scope || 'c2c') === 'group')
        if (!panels.length) lines.push('配置中没有 group 场景面板。')
        for (const item of panels) {
          const specific = (item.targetType || 'all') === 'specific'
          const matched = !specific || (item.groupOpenIds || []).includes(openId)
          lines.push(`- ${item.key}：${specific ? (matched ? '指定生效（含本群）' : '指定生效（不含本群）') : '全群生效'}`)
        }
        lines.push('把该 OpenID 填进面板的 groupOpenIds 并把 targetType 设为 specific，即可让不同群显示不同指令面板。')
        return lines.join('\n')
      })
    })

  ctx.command('qqpanel.sync', '按配置下发 QQ 指令面板')
    .alias('qq面板同步')
    .userFields(['authority'])
    .action(({ session }) => {
      if (!isManager(session)) return '你没有管理 QQ 菜单/面板的权限。'
      return run(async () => formatResult(await syncAll({ resources: ['panels'] })))
    })

  ctx.command('qqpanel.delete <panelId:string>', '删除指定的 QQ 指令面板')
    .alias('qq面板删除')
    .userFields(['authority'])
    .action(({ session }, panelId) => {
      if (!isManager(session)) return '你没有管理 QQ 菜单/面板的权限。'
      if (!panelId) return '用法：qqpanel.delete <panel_id>'
      return run(async () => {
        await api.deletePanel(requireBot().http, panelId)
        return `已删除面板 ${panelId}。`
      })
    })

  ctx.command('qqsync', '同时下发自定义菜单与指令面板')
    .alias('qq同步')
    .userFields(['authority'])
    .action(({ session }) => {
      if (!isManager(session)) return '你没有管理 QQ 菜单/面板的权限。'
      return run(async () => formatResult(await syncAll()))
    })

  authorize.registerAuthorizeCommand(ctx, config, logger)

  let retries = 0
  async function autoSync(reason) {
    if (disposed || !config.autoSync) return
    const online = onlineBots()
    if (!online.length) return false
    for (const bot of online) {
      if (autoSynced.has(bot.selfId)) continue
      autoSynced.add(bot.selfId)
      attach(bot)
      try {
        const result = await syncAll({ bot })
        if (disposed) return true
        logger.info('启动自动同步完成（%s）：%s', reason, formatResult(result))
      } catch (error) {
        autoSynced.delete(bot.selfId)
        logger.warn('启动自动同步失败（%s）：%s', reason, api.describeError(error))
      }
    }
    return true
  }

  function scheduleRetry() {
    if (disposed || !config.autoSync) return
    if (retries >= 30) return
    retries += 1
    ctx.setTimeout(() => {
      void autoSync('retry').then((done) => { if (!done) scheduleRetry() })
    }, 20000)
  }

  ctx.on('bot-added', (bot) => {
    attach(bot)
    void autoSync('bot-added')
  })

  ctx.on('bot-status-updated', (bot) => {
    attach(bot)
    void autoSync('bot-status-updated')
  })

  ctx.on('ready', () => {
    for (const bot of bots()) attach(bot)
    void autoSync('ready').then((done) => { if (!done) scheduleRetry() })
  })

  for (const bot of bots()) attach(bot)
}