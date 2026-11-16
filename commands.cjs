'use strict'

/**
 * 从 Koishi 命令注册表自动生成 QQ「指令面板」元素。
 *
 * 数据来源：`ctx.$commander._commandList`（@koishijs/core 的 Commander 服务），
 * 描述来自 i18n 键 `commands.<name>.description`（与 `Command#toJSON()` 一致），
 * 因此插件注册/改名/改描述后，面板内容会自动跟着变，不需要手工维护命令清单。
 *
 * 元素形态遵循平台限制（`api.LIMITS`）：名称 ≤ 14、描述 ≤ 30（中文按 2 个字符计），
 * 名称同时是点击后填入输入框的内容，因此统一带上命令前缀（默认取 Koishi 的 prefix）。
 */

const api = require('./api.cjs')

/** 默认排除：本插件自己的管理命令，避免出现在面向用户的指令面板里 */
const DEFAULT_EXCLUDE = ['qqmenu*', 'qqpanel*', 'qqsync']

function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 通配匹配：`*` 任意字符，无通配时按相等匹配；大小写不敏感。 */
function matchPattern(pattern, name) {
  const text = String(pattern ?? '').trim().toLowerCase()
  if (!text) return false
  const target = String(name ?? '').toLowerCase()
  if (!text.includes('*')) return target === text
  return new RegExp(`^${text.split('*').map(escapeRegExp).join('.*')}$`).test(target)
}

function matchesAny(patterns, name) {
  return (patterns || []).some((pattern) => matchPattern(pattern, name))
}

/** 取 commander 服务（兼容 ctx.get('$commander')）。 */
function getCommander(ctx) {
  if (ctx && ctx.$commander && Array.isArray(ctx.$commander._commandList)) return ctx.$commander
  if (ctx && typeof ctx.get === 'function') {
    const service = ctx.get('$commander')
    if (service && Array.isArray(service._commandList)) return service
  }
  throw new Error('Koishi 命令注册表（$commander）不可用，无法自动生成指令面板')
}

/** 解析命令的最低权限等级（config.permissions 里的 authority:N，取最大值）。 */
function commandAuthority(command) {
  const permissions = (command && command.config && command.config.permissions) || []
  let authority = 0
  for (const entry of permissions) {
    const matched = /^authority:(\d+)$/.exec(String(entry))
    if (matched) authority = Math.max(authority, Number(matched[1]))
  }
  return authority
}

/**
 * hidden 解析：只处理布尔与「计算结果」。
 * 不能在无会话时求值的计算值（Schema.computed / 函数）按隐藏处理，避免把内部指令发布给用户；
 * 这里刻意不访问 ctx.resolve：它不是注册服务，访问会触发 cordis 的 “not registered” 告警。
 */
function resolveFlag(value) {
  if (value === undefined || value === null || value === false) return false
  if (value === true) return true
  if (typeof value === 'function') {
    try {
      const resolved = value()
      if (typeof resolved === 'boolean') return resolved
    } catch {
      return true
    }
    return true
  }
  return Boolean(value)
}

/**
 * i18n 查找结果可能是字符串，也可能是 { locale: text }（I18n#get 返回按回退顺序排列的记录），
 * 这里统一取第一个非空字符串。
 */
function pickText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key]
    }
  }
  return undefined
}

function describe(command, fallbackCtx, limit) {
  // i18n 定义注册在「命令所在插件的 ctx」上，因此优先用 command.ctx 读取
  const candidates = [command && command.ctx && command.ctx.i18n, fallbackCtx && fallbackCtx.i18n]
  let text
  for (const i18n of candidates) {
    if (!i18n || typeof i18n.get !== 'function') continue
    try {
      text = pickText(i18n.get(`commands.${command.name}.description`))
    } catch {
      text = undefined
    }
    if (text) break
  }
  if (!text) return undefined
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return truncate(text, limit)
}

/** 按平台字符宽度截断（中文按 2 计），末尾加省略号。 */
function truncate(text, limit) {
  if (api.textWeight(text) <= limit) return text
  const chars = [...text]
  let result = ''
  for (const char of chars) {
    if (api.textWeight(result + char) + 2 > limit) break
    result += char
  }
  return result.trimEnd() + '…'
}

/**
 * 挑选面板元素名称（= 点击后填入输入框的内容）：
 * 优先带中文的别名（QQ 用户更易读），其次最短，且必须满足平台长度限制。
 */
function pickLabel(ctx, command, prefix) {
  const candidates = []
  const seen = new Set()
  for (const name of Object.keys(command._aliases || {})) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    candidates.push(name)
  }
  if (command.name && !seen.has(command.name)) candidates.push(command.name)
  const scored = candidates
    .map((candidate) => ({
      candidate,
      weight: api.textWeight(prefix + candidate),
      wide: api.textWeight(candidate) > candidate.length,
    }))
    .filter((entry) => entry.weight <= api.LIMITS.panelItemName)
    .sort((a, b) => (Number(b.wide) - Number(a.wide)) || (a.weight - b.weight) || (a.candidate.length - b.candidate.length))
  return scored.length ? prefix + scored[0].candidate : undefined
}

/**
 * 收集可用命令并按配置过滤。
 * @returns {{ entries: Array, warnings: Array<string> }}
 */
function collectEntries(ctx, options = {}) {
  const commander = getCommander(ctx)
  const prefix = options.prefix === undefined ? '' : String(options.prefix)
  const include = options.include || []
  const exclude = [...DEFAULT_EXCLUDE, ...(options.exclude || [])]
  const maxAuthority = options.maxAuthority === undefined ? 3 : Number(options.maxAuthority)
  const adminAuthority = options.adminAuthority === undefined ? 3 : Number(options.adminAuthority)
  const withSubcommands = Boolean(options.subcommands)
  const warnings = []
  const entries = []

  for (const command of commander._commandList) {
    const name = command && command.name
    if (!name) continue
    const isSubcommand = name.includes('.')
    const explicitlyIncluded = matchesAny(include, name)
    if (isSubcommand && !withSubcommands && !explicitlyIncluded) continue
    if (matchesAny(exclude, name)) continue
    if (command.config && command.config.slash === false) continue
    if (resolveFlag(command.config && command.config.hidden)) continue
    const authority = commandAuthority(command)
    if (authority > maxAuthority) continue
    const label = pickLabel(ctx, command, prefix)
    if (!label) {
      warnings.push(`命令 ${name} 的名称超出平台限制（含前缀最多 ${api.LIMITS.panelItemName} 个字符），已跳过`)
      continue
    }
    entries.push({
      name,
      label,
      desc: describe(command, ctx, api.LIMITS.panelItemDesc),
      authority,
      onlyAdmin: authority >= adminAuthority,
      included: explicitlyIncluded,
      wide: api.textWeight(label) > label.length,
    })
  }

  return { entries, warnings }
}

/**
 * 生成指令面板元素列表（平台形态）。
 * @param {object} ctx Koishi 上下文
 * @param {object} panel 面板配置（include/exclude/subcommands/maxAuthority/adminAuthority/maxItems/prefix/extraItems）
 */
function generateItems(ctx, panel = {}) {
  const maxItems = panel.maxItems === undefined ? api.LIMITS.panelItems : Number(panel.maxItems)
  const prefix = panel.prefix === undefined || panel.prefix === null ? '' : String(panel.prefix)
  const { entries, warnings } = collectEntries(ctx, {
    prefix,
    include: panel.include,
    exclude: panel.exclude,
    subcommands: panel.subcommands,
    maxAuthority: panel.maxAuthority,
    adminAuthority: panel.adminAuthority,
  })

  // 排序：显式 include 命中的命令优先（按 include 的顺序），其余按权限、名称
  const orderOf = (entry) => {
    const index = (panel.include || []).findIndex((pattern) => matchPattern(pattern, entry.name))
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  // 排序：显式 include 优先 -> 中文标签（通常在 QQ 里更面向用户）-> 权限 -> 名称
  const sorted = entries.slice().sort((a, b) =>
    (orderOf(a) - orderOf(b))
    || (Number(b.wide) - Number(a.wide))
    || (a.authority - b.authority)
    || a.name.localeCompare(b.name))

  const extraItems = (panel.extraItems || []).map((item) => ({ ...item }))
  const budget = Math.max(0, maxItems - extraItems.length)
  if (sorted.length > budget) {
    const dropped = sorted.slice(budget).map((entry) => entry.label)
    warnings.push(`命令数量 ${sorted.length} 超过面板上限 ${maxItems}，已按顺序保留前 ${budget} 个，忽略：${dropped.join('、')}（可用 exclude/include 调整）`)
  }
  const items = sorted.slice(0, budget).map((entry) => ({
    type: 'command',
    name: entry.label,
    desc: entry.desc,
    onlyAdmin: entry.onlyAdmin,
  }))
  items.push(...extraItems)

  return { items, warnings, entries, generated: items.length }
}

module.exports = {
  DEFAULT_EXCLUDE,
  pickText,
  matchPattern,
  matchesAny,
  commandAuthority,
  truncate,
  collectEntries,
  generateItems,
}