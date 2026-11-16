'use strict'

/**
 * QQ 机器人 OpenAPI v2：自定义菜单（/v2/menu）与指令面板（/v2/panels）适配层。
 *
 * 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/
 * 平台变更记录：2026-08-12 新增「自定义菜单」查询/修改与「指令面板」管理接口；
 *              2026-08-10 起全部接口调用域名统一为 api.bot.qq.com（适配器默认的
 *              api.sgroup.qq.com 仍可访问同一接口，2026-09-21 已实测）。
 *
 * 平台约束：
 * - 自定义菜单只作用于 C2C 单聊，PUT 会完整覆盖已有菜单；
 * - 指令面板支持 c2c/group/channel/dm，只有 c2c/group 支持 target_type=specific；
 * - 单个机器人最多 20 个指令面板，单个面板最多 20 个元素；
 * - 名称/描述长度按「一个中文汉字算 2 个字符」计算。
 *
 * 输入同时接受插件配置使用的 camelCase 与平台原始 snake_case 字段名，输出统一为
 * 平台格式。所有请求都通过 @satorijs/adapter-qq 的 bot.http 发出，复用适配器的
 * endpoint、访问令牌与 X-Union-Appid 头，不额外保存任何凭据。
 */

const MENU_PATH = '/v2/menu'
const PANELS_PATH = '/v2/panels'

const MENU_ITEM_TYPES = ['switch', 'send_message', 'link', 'menu']
const SUB_MENU_ITEM_TYPES = ['send_message', 'link']
const PANEL_ITEM_TYPES = ['command', 'link']
const PANEL_SCOPES = ['c2c', 'group', 'channel', 'dm']
const PANEL_TARGET_TYPES = ['all', 'specific']
const PANEL_TARGET_OPS = ['add', 'del']

const LIMITS = {
  menuItems: 10,
  subMenuItems: 5,
  menuItemName: 10,
  subMenuItemName: 14,
  panelItems: 20,
  panelItemName: 14,
  panelItemDesc: 30,
  panelRemark: 255,
  panelsPerApp: 20,
  openIdsPerRequest: 20,
}

/** 宽字符（CJK、全角符号、谚文等）在平台计数中占 2 个字符 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

function textWeight(value) {
  let weight = 0
  for (const char of String(value ?? '')) weight += WIDE_CHAR.test(char) ? 2 : 1
  return weight
}

function fail(message) {
  throw new Error(`[qq-menu-panel] ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function assertOneOf(value, allowed, label) {
  assert(allowed.includes(value), `${label}只能是 ${allowed.join(' / ')}，收到 ${JSON.stringify(value)}`)
  return value
}

function assertText(value, limit, label) {
  assert(typeof value === 'string' && value.trim(), `${label}不能为空`)
  const text = value.trim()
  const weight = textWeight(text)
  assert(weight <= limit, `${label}超长：${weight}/${limit} 个字符（中文按 2 个字符计）`)
  return text
}

function assertHttps(value, label) {
  assert(typeof value === 'string' && value.trim(), `${label}不能为空`)
  const url = value.trim()
  assert(/^https:\/\//i.test(url), `${label}必须以 https:// 开头，收到 ${url}`)
  return url
}

function assertOptionalText(value, limit, label) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  return assertText(text, limit, label)
}

function assertOpenIdList(value, label) {
  assert(Array.isArray(value) && value.length, `${label}必须是非空数组`)
  assert(value.length <= LIMITS.openIdsPerRequest, `${label}一次最多 ${LIMITS.openIdsPerRequest} 个，收到 ${value.length}`)
  const list = value.map((item) => String(item).trim()).filter(Boolean)
  assert(list.length === value.length, `${label}中存在空值`)
  return list
}

function pick(source, camel, snake) {
  if (!source || typeof source !== 'object') return undefined
  const value = source[camel]
  return value === undefined ? source[snake] : value
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined
}

/* ------------------------------------------------------------------ 自定义菜单 */

function normalizeSubMenuItem(input, label) {
  assert(input && typeof input === 'object' && !Array.isArray(input), `${label}必须是对象`)
  const type = assertOneOf(input.type, SUB_MENU_ITEM_TYPES, `${label} type`)
  const item = { type, name: assertText(input.name, LIMITS.subMenuItemName, `${label}名称`) }
  if (type === 'send_message') {
    const text = pick(input, 'sendMessage', 'send_message')
    assert(typeof text === 'string' && text.trim(), `${label}缺少 sendMessage`)
    item.send_message = text.trim()
  } else {
    item.link = assertHttps(input.link, `${label} link`)
  }
  return item
}

function normalizeMenuItem(input, index) {
  const label = `菜单项 #${index + 1}`
  assert(input && typeof input === 'object' && !Array.isArray(input), `${label}必须是对象`)
  const type = assertOneOf(input.type, MENU_ITEM_TYPES, `${label}的 type`)
  const item = { type, name: assertText(input.name, LIMITS.menuItemName, `${label}名称`) }
  if (type === 'send_message') {
    const text = pick(input, 'sendMessage', 'send_message')
    assert(typeof text === 'string' && text.trim(), `${label}（send_message）缺少 sendMessage`)
    item.send_message = text.trim()
  } else if (type === 'link') {
    item.link = assertHttps(input.link, `${label}的 link`)
  } else if (type === 'switch') {
    const switchId = str(input.switchId) || str(input.switch && input.switch.switch_id)
    assert(switchId, `${label}（switch）缺少 switchId`)
    item.switch = {
      switch_id: switchId,
      default: Boolean(input.switchDefault ?? (input.switch && input.switch.default)),
    }
  } else {
    const subs = pick(input, 'subMenuItems', 'sub_menu_items') ?? []
    assert(Array.isArray(subs), `${label}的 subMenuItems 必须是数组`)
    assert(subs.length && subs.length <= LIMITS.subMenuItems, `${label}子菜单数量必须是 1-${LIMITS.subMenuItems}，收到 ${subs.length}`)
    item.sub_menu_items = subs.map((sub, index2) => normalizeSubMenuItem(sub, `${label}子菜单 #${index2 + 1}`))
  }
  return item
}

/** 校验并规整菜单配置，接受 { items } 或直接数组。 */
function normalizeMenu(input) {
  const items = Array.isArray(input) ? input : pick(input, 'items', 'items') || []
  assert(Array.isArray(items), '菜单 items 必须是数组')
  assert(items.length <= LIMITS.menuItems, `菜单项最多 ${LIMITS.menuItems} 个，收到 ${items.length}`)
  return { items: items.map((item, index) => normalizeMenuItem(item, index)) }
}

/* ------------------------------------------------------------------ 指令面板 */

function normalizePanelItem(input, index) {
  const label = `面板元素 #${index + 1}`
  assert(input && typeof input === 'object' && !Array.isArray(input), `${label}必须是对象`)
  const type = assertOneOf(input.type, PANEL_ITEM_TYPES, `${label}的 type`)
  const item = { type, name: assertText(input.name, LIMITS.panelItemName, `${label}名称`) }
  const desc = assertOptionalText(input.desc, LIMITS.panelItemDesc, `${label}描述`)
  if (desc) item.desc = desc
  if (type === 'link') item.link = assertHttps(input.link, `${label}的 link`)
  item.only_admin = Boolean(pick(input, 'onlyAdmin', 'only_admin'))
  return item
}

/** 校验并规整面板内容。 */
function normalizePanel(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '面板内容必须是对象')
  const items = input.items ?? []
  assert(Array.isArray(items), '面板 items 必须是数组')
  assert(items.length <= LIMITS.panelItems, `面板元素最多 ${LIMITS.panelItems} 个，收到 ${items.length}`)
  const panel = { items: items.map((item, index) => normalizePanelItem(item, index)) }
  const remark = assertOptionalText(input.remark, LIMITS.panelRemark, '面板备注')
  if (remark) panel.remark = remark
  const version = num(input.version)
  if (version !== undefined) panel.version = version
  return panel
}

/** 构造 POST /v2/panels 请求体。 */
function buildPanelCreate(input) {
  assert(input && typeof input === 'object', '创建面板需要配置对象')
  const scope = assertOneOf(input.scope, PANEL_SCOPES, '面板 scope')
  const targetType = assertOneOf(input.targetType ?? pick(input, 'targetType', 'target_type') ?? 'all', PANEL_TARGET_TYPES, '面板 targetType')
  if (targetType === 'specific') {
    assert(scope === 'c2c' || scope === 'group', `targetType=specific 只支持 c2c/group 场景，收到 ${scope}`)
  }
  const payload = { scope, target_type: targetType, panel: normalizePanel(input.panel ?? input) }
  if (targetType === 'specific') {
    const key = scope === 'group' ? 'groupOpenIds' : 'userOpenIds'
    const snake = scope === 'group' ? 'group_openids' : 'user_openids'
    payload[snake] = assertOpenIdList(pick(input, key, snake), key)
  }
  return payload
}

/** 构造 PUT /v2/panels/{panel_id}/target 请求体。 */
function buildPanelTarget(input) {
  assert(input && typeof input === 'object', '修改面板关联对象需要配置对象')
  const op = assertOneOf(input.op, PANEL_TARGET_OPS, '关联对象操作 op')
  const payload = { op }
  const userOpenIds = pick(input, 'userOpenIds', 'user_openids')
  const groupOpenIds = pick(input, 'groupOpenIds', 'group_openids')
  if (userOpenIds) payload.user_openids = assertOpenIdList(userOpenIds, 'userOpenIds')
  if (groupOpenIds) payload.group_openids = assertOpenIdList(groupOpenIds, 'groupOpenIds')
  assert(payload.user_openids || payload.group_openids, '关联对象操作必须提供 userOpenIds 或 groupOpenIds')
  return payload
}

/* ------------------------------------------------------------------ 差异比较

 * 下面这些 canonical* 函数把「本地期望值」和「平台返回值」规整成同一形态，
 * 只保留平台承认的字段，并按字段名排序后比较，避免空值/字段缺失导致的误判。
 */

function canonicalSubMenuItem(input) {
  if (!input || typeof input !== 'object') return undefined
  const out = { type: input.type, name: str(input.name) }
  if (input.type === 'send_message') out.send_message = str(input.send_message)
  else if (input.type === 'link') out.link = str(input.link)
  return out
}

function canonicalMenuItem(input) {
  if (!input || typeof input !== 'object') return undefined
  const out = { type: input.type, name: str(input.name) }
  const sendMessage = str(input.send_message)
  const link = str(input.link)
  if (input.type === 'send_message') out.send_message = sendMessage
  else if (input.type === 'link') out.link = link
  else if (input.type === 'switch') {
    out.switch = {
      switch_id: str(input.switch && input.switch.switch_id),
      default: Boolean(input.switch && input.switch.default),
    }
  } else if (input.type === 'menu') {
    out.sub_menu_items = (input.sub_menu_items ?? []).map(canonicalSubMenuItem)
  }
  return out
}

function canonicalPanelItem(input) {
  if (!input || typeof input !== 'object') return undefined
  const out = { type: input.type, name: str(input.name) }
  const desc = str(input.desc)
  if (desc) out.desc = desc
  if (input.type === 'link') out.link = str(input.link)
  out.only_admin = Boolean(input.only_admin)
  return out
}

function canonicalPanel(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    items: (source.items ?? []).map(canonicalPanelItem),
    remark: str(source.remark),
  }
}

/* ------------------------------------------------------------------ 请求封装 */

function describeError(error) {
  const data = error && error.response && error.response.data
  const code = data && (data.err_code ?? data.code)
  const message = (data && data.message) || (error && error.message) || String(error)
  const trace = data && data.trace_id ? `，trace_id ${data.trace_id}` : ''
  if (code) return `${message}（err_code ${code}）${trace}`
  return `${message}${trace}`
}

/** 平台返回的业务错误码（err_code 或 code）。 */
function errorCode(error) {
  const data = error && error.response && error.response.data
  return data ? (data.err_code ?? data.code) : undefined
}

/** 是否为平台限频错误：菜单写入 5 次/分钟、面板写入 10 次/分钟。 */
function isRateLimited(error) {
  if (Number(errorCode(error)) === 40023001) return true
  return Boolean(error && error.response && error.response.status === 429)
}

function panelPath(panelId) {
  assert(typeof panelId === 'string' && panelId.trim(), 'panel_id 不能为空')
  return `${PANELS_PATH}/${encodeURIComponent(panelId.trim())}`
}

async function send(http, method, path, options = {}) {
  const config = { method }
  if (options.data !== undefined) config.data = options.data
  if (options.params !== undefined) config.params = options.params
  try {
    const response = await http(path, config)
    return response && response.data
  } catch (error) {
    if (error && error.response) error.message = describeError(error)
    throw error
  }
}

async function getMenu(http) {
  const data = await send(http, 'GET', MENU_PATH)
  return { version: num(data && data.version) ?? 0, menu: (data && data.menu) || {} }
}

async function updateMenu(http, menu) {
  const data = await send(http, 'PUT', MENU_PATH, { data: { menu: normalizeMenu(menu) } })
  return { version: num(data && data.version) ?? 0 }
}

async function getPanels(http, params = {}) {
  const scope = assertOneOf(params.scope, PANEL_SCOPES, '查询面板的 scope')
  const query = { scope }
  if (params.cursor) query.cursor = params.cursor
  if (params.limit) query.limit = params.limit
  const data = await send(http, 'GET', PANELS_PATH, { params: query })
  return {
    records: (data && data.records) || [],
    nextCursor: (data && data.next_cursor) || '',
    isEnd: !data || data.is_end === true,
  }
}

/** 分页拉取指定场景下的全部面板，防御性去重游标。 */
async function getAllPanels(http, scope, limit = 50) {
  const records = []
  const seen = new Set()
  let cursor = ''
  for (let page = 0; page < 20; page += 1) {
    const result = await getPanels(http, { scope, cursor, limit })
    for (const record of result.records) {
      if (!record || !record.panel_id || seen.has(record.panel_id)) continue
      seen.add(record.panel_id)
      records.push(record)
    }
    if (result.isEnd || !result.nextCursor) break
    if (seen.has(`cursor:${result.nextCursor}`)) break
    seen.add(`cursor:${result.nextCursor}`)
    cursor = result.nextCursor
  }
  return records
}

async function createPanel(http, payload) {
  const body = payload && payload.panel ? payload : buildPanelCreate(payload)
  const data = await send(http, 'POST', PANELS_PATH, { data: body })
  return { panelId: data && data.panel_id, scope: body.scope }
}

async function getPanel(http, panelId) {
  return (await send(http, 'GET', panelPath(panelId))) || {}
}

async function updatePanel(http, panelId, panel) {
  const data = await send(http, 'PUT', panelPath(panelId), { data: { panel: normalizePanel(panel) } })
  return { version: num(data && data.version) ?? 0 }
}

async function deletePanel(http, panelId) {
  await send(http, 'DELETE', panelPath(panelId))
  return true
}

async function updatePanelTarget(http, panelId, payload) {
  await send(http, 'PUT', `${panelPath(panelId)}/target`, { data: buildPanelTarget(payload) })
  return true
}

module.exports = {
  MENU_PATH,
  PANELS_PATH,
  MENU_ITEM_TYPES,
  SUB_MENU_ITEM_TYPES,
  PANEL_ITEM_TYPES,
  PANEL_SCOPES,
  PANEL_TARGET_TYPES,
  PANEL_TARGET_OPS,
  LIMITS,
  textWeight,
  normalizeMenu,
  normalizePanel,
  buildPanelCreate,
  buildPanelTarget,
  canonicalMenuItem,
  canonicalPanel,
  canonicalPanelItem,
  describeError,
  errorCode,
  isRateLimited,
  getMenu,
  updateMenu,
  getPanels,
  getAllPanels,
  createPanel,
  getPanel,
  updatePanel,
  deletePanel,
  updatePanelTarget,
}