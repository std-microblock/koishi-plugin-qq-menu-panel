'use strict'

/**
 * 自定义菜单/指令面板的差异计算（纯函数，便于单测）。
 *
 * 同步语义：以插件配置为期望状态，先读取平台现状，只有内容不一致时才提交请求，
 * 避免每次启动都写平台（菜单 PUT 限频 5 QPM，面板写操作限频 10 QPM）。
 */

const api = require('./api.cjs')

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      if (item === undefined) continue
      out[key] = sortValue(item)
    }
    return out
  }
  return value
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b)
}

/** 菜单差异：期望项与平台项是否一致。 */
function planMenu(remote, desired) {
  const remoteItems = ((remote && remote.menu && remote.menu.items) || []).map(api.canonicalMenuItem)
  const desiredItems = (desired.items || []).map(api.canonicalMenuItem)
  return {
    changed: !sameJson(remoteItems, desiredItems),
    remoteVersion: (remote && remote.version) || 0,
    remoteItemCount: remoteItems.length,
    desiredItemCount: desiredItems.length,
  }
}

/**
 * 把插件配置面板规整为平台形态。
 * 复用 api.buildPanelCreate 做校验（scope/targetType/元素数量/链接/长度），
 * 保证「配置校验」和「请求构造」只有一处实现。
 */
function normalizePanelConfig(input, index, options = {}) {
  const prefix = options.remarkPrefix || 'koishi:'
  const label = `面板 #${index + 1}`
  if (!input || typeof input !== 'object') throw new Error(`${label} 必须是对象`)
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  if (!key) throw new Error(`${label} 缺少 key（本地标识，用于生成面板备注并匹配远端面板）`)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw new Error(`${label} 的 key 只能包含字母、数字、. _ -，且不超过 64 个字符`)
  const remark = typeof input.remark === 'string' && input.remark.trim() ? input.remark.trim() : `${prefix}${key}`
  // items 可由调用方解析后传入（source=commands 时来自命令注册表）
  const items = options.items === undefined ? input.items : options.items
  const payload = api.buildPanelCreate({
    scope: input.scope,
    targetType: input.targetType,
    userOpenIds: input.userOpenIds,
    groupOpenIds: input.groupOpenIds,
    panel: { items, remark },
  })
  return {
    key,
    remark: payload.panel.remark,
    scope: payload.scope,
    targetType: payload.target_type,
    userOpenIds: payload.user_openids || [],
    groupOpenIds: payload.group_openids || [],
    panelId: typeof input.panelId === 'string' ? input.panelId.trim() : '',
    panel: payload.panel,
    source: input,
  }
}

/** 建立远端面板索引：按 panel_id 与按备注（备注是本地 key 的载体）。 */
function indexPanels(records) {
  const byId = new Map()
  const byRemark = new Map()
  for (const record of records || []) {
    if (!record || !record.panel_id) continue
    byId.set(record.panel_id, record)
    const remark = record.panel && record.panel.remark
    if (remark && !byRemark.has(remark)) byRemark.set(remark, record)
  }
  return { byId, byRemark }
}

/** 把期望面板与远端记录配对；绑定 panelId 时按 ID，否则按备注。 */
function matchPanels(desired, records) {
  const index = indexPanels(records)
  return (desired || []).map((panel) => ({
    panel,
    record: panel.panelId ? index.byId.get(panel.panelId) : index.byRemark.get(panel.remark),
  }))
}

/** 关联对象差异：需要新增/移除的 openid。 */
function diffOpenIds(desired, remote) {
  const want = new Set((desired || []).map(String).filter(Boolean))
  const have = new Set((remote || []).map(String).filter(Boolean))
  return {
    add: [...want].filter((id) => !have.has(id)),
    del: [...have].filter((id) => !want.has(id)),
  }
}

function samePanelItems(a, b) {
  return sameJson((a || []).map(api.canonicalPanelItem), (b || []).map(api.canonicalPanelItem))
}

/**
 * 计算面板同步动作。
 * @param {Array} matches matchPanels 的结果
 * @param {Map} details panel_id -> 详情（仅 target_type=specific 的面板需要）
 * @param {Array} records 本次读取到的全部远端记录
 * @param {string} remarkPrefix 本插件管理的面板备注前缀
 * @param {boolean} prune 是否删除带前缀备注但配置中已不存在的面板
 */
function planPanels(options) {
  const matches = options.matches || []
  const details = options.details
  const records = options.records || []
  const prefix = options.remarkPrefix || 'koishi:'
  const actions = []
  const claimed = new Set()

  for (const { panel, record } of matches) {
    if (!record) {
      actions.push({
        type: 'create',
        panel,
        note: panel.panelId ? `绑定的 panel_id ${panel.panelId} 在 ${panel.scope} 场景中不存在，将重新创建` : undefined,
      })
      continue
    }
    claimed.add(record.panel_id)

    if (record.scope && panel.scope && record.scope !== panel.scope) {
      actions.push({
        type: 'recreate',
        panel,
        panelId: record.panel_id,
        reason: `生效场景需要从 ${record.scope} 改为 ${panel.scope}`
      })
      continue
    }

    if (record.target_type && record.target_type !== panel.targetType) {
      actions.push({
        type: 'recreate',
        panel,
        panelId: record.panel_id,
        reason: `作用范围需要从 ${record.target_type} 改为 ${panel.targetType}`
      })
      continue
    }

    const remotePanel = record.panel || {}
    const itemsChanged = !samePanelItems(panel.panel.items, remotePanel.items)
    const remarkChanged = (remotePanel.remark || '') !== (panel.panel.remark || '')
    if (itemsChanged || remarkChanged) {
      actions.push({ type: 'update', panel, panelId: record.panel_id, itemsChanged, remarkChanged })
    } else {
      actions.push({ type: 'unchanged', panel, panelId: record.panel_id })
    }

    if (panel.targetType === 'specific') {
      const detail = details && typeof details.get === 'function' ? details.get(record.panel_id) : undefined
      if (!detail) {
        actions.push({ type: 'warn', panel, message: `未取得面板 ${record.panel_id} 的详情，跳过关联对象校验` })
      } else {
        const field = panel.scope === 'group' ? 'group_openids' : 'user_openids'
        const desiredIds = panel.scope === 'group' ? panel.groupOpenIds : panel.userOpenIds
        const { add, del } = diffOpenIds(desiredIds, detail[field])
        if (add.length) actions.push({ type: 'target', panel, panelId: record.panel_id, op: 'add', scope: panel.scope, openIds: add })
        if (del.length) actions.push({ type: 'target', panel, panelId: record.panel_id, op: 'del', scope: panel.scope, openIds: del })
      }
    }
  }

  if (options.prune) {
    for (const record of records) {
      const remark = record && record.panel && record.panel.remark
      if (!remark || !String(remark).startsWith(prefix)) continue
      if (claimed.has(record.panel_id)) continue
      actions.push({ type: 'delete', panelId: record.panel_id, remark })
    }
  }

  return actions
}

module.exports = {
  stableStringify,
  sameJson,
  planMenu,
  normalizePanelConfig,
  indexPanels,
  matchPanels,
  diffOpenIds,
  samePanelItems,
  planPanels,
}