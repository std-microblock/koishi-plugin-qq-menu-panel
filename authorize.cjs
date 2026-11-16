'use strict'

/**
 * 群主授权指令：让官方机器人「接收群内全部消息」并允许「主动在群聊内发言」。
 *
 * 手机 QQ（9.2.90+）的授权弹窗页由下面的地址打开：
 *   https://club.vip.qq.com/transfer?open_kuikly_info=<encodeURIComponent(JSON)>
 *   JSON = { page_name: 'ai_group_service_agreement_pop_page', groupCode, botUin, botUid, screen: 1 }
 *
 * 实现要点：
 * - 机器人身份（QQ 号 + UID）由使用者填在配置里（`authorize.botUin` / `authorize.botUid`），
 *   插件不内置任何机器人身份，也不查询任何本地接口。
 * - 不在消息里直接贴链接（官方机器人发裸链接会被拦截），而是用 link 按钮跳转。
 * - 官方机器人拿不到真实群号（只有 openid），因此由用户在参数里填群号；一个群授权一次即可，不做记忆。
 * - 随消息附带授权示意图、手动设置教程图，缺群号时附带「如何找到群号」教程图。
 */

const fs = require('node:fs')
const path = require('node:path')
const { h } = require('koishi')

/**
 * 机器人身份不内置：授权页必须带上「本机器人」的 QQ 号与 UID，
 * 由使用者在配置里填（见 README「怎么拿到 botUin / botUid」）。
 */
const DEFAULT_BOT_UIN = ''
const DEFAULT_BOT_UID = ''
const DEFAULT_COMMAND = '授权全消息'
const COMMAND_DESCRIPTION = '群主授权：全部消息+主动发言'

const TRANSFER_ENDPOINT = 'https://club.vip.qq.com/transfer'
const TRANSFER_PAGE = 'ai_group_service_agreement_pop_page'

/** 随插件打包的图片（源文件见仓库 guides/*.html，用 node guides/render.cjs 生成） */
const ASSETS = {
  authorize: 'authorize-guide.png',
  manual: 'manual-guide.png',
  groupCode: 'group-code-guide.png',
}

const DEFAULTS = {
  enabled: true,
  command: DEFAULT_COMMAND,
  botUin: DEFAULT_BOT_UIN,
  botUid: DEFAULT_BOT_UID,
  inputPrefix: '/',
  sendImages: true,
}

/** 全角数字转半角，去掉空白；返回 { ok, groupCode } 或 { ok: false, reason, input } */
function normalizeGroupCode(input) {
  if (input === undefined || input === null) return { ok: false, reason: 'missing' }
  const text = String(input)
    .replace(/[\uFF10-\uFF19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
  if (!text) return { ok: false, reason: 'missing' }
  if (!/^[1-9]\d{4,11}$/.test(text)) return { ok: false, reason: 'invalid', input: text }
  return { ok: true, groupCode: text }
}

/** 校验配置里填写的官方机器人身份 */
function validateIdentity(options) {
  const botUin = String(options.botUin || '').trim()
  const botUid = String(options.botUid || '').trim()
  if (!/^[1-9]\d{4,11}$/.test(botUin)) {
    const hint = botUin ? `配置无效：${botUin}` : '未配置'
    return { ok: false, message: `authorize.botUin ${hint}（请填写本机器人的 QQ 号，获取方法见 README）` }
  }
  if (!botUid) return { ok: false, message: 'authorize.botUid 未配置（请填写本机器人的 UID，形如 u_xxxxxxxxxxxxxxxxxxxxxx，获取方法见 README）' }
  return { ok: true, botUin, botUid }
}

/** 生成手机 QQ 授权弹窗页地址（JSON 单行压缩后整体 encodeURIComponent） */
function buildTransferUrl({ groupCode, botUin, botUid }) {
  const payload = {
    page_name: TRANSFER_PAGE,
    groupCode: Number(groupCode),
    botUin: Number(botUin),
    botUid,
    screen: 1,
  }
  return `${TRANSFER_ENDPOINT}?open_kuikly_info=${encodeURIComponent(JSON.stringify(payload))}`
}

function resolveOptions(config) {
  const options = { ...DEFAULTS, ...((config && config.authorize) || {}) }
  options.command = String(options.command || DEFAULT_COMMAND).trim() || DEFAULT_COMMAND
  options.inputPrefix = options.inputPrefix === undefined || options.inputPrefix === null ? '/' : String(options.inputPrefix)
  return options
}

function loadImages(logger, assetDir = path.join(__dirname, 'assets')) {
  const images = {}
  for (const [key, file] of Object.entries(ASSETS)) {
    try {
      images[key] = fs.readFileSync(path.join(assetDir, file))
    } catch (error) {
      logger.warn('授权教程图缺失（%s）：%s', file, error && error.message)
    }
  }
  return images
}

/** 注册授权指令；返回指令对象（未启用时返回 undefined） */
function registerAuthorizeCommand(ctx, config, logger, deps = {}) {
  const options = resolveOptions(config)
  if (options.enabled === false) return undefined
  const images = deps.images || loadImages(logger)
  const commandText = `${options.inputPrefix}${options.command} `

  function imageElements(keys) {
    if (!options.sendImages) return []
    return keys.filter((key) => images[key]).map((key) => h.image(images[key], 'image/png'))
  }

  /** 先发图片再发按钮卡片：适配器在出现按钮后会把同一次发送里的后续消息都转成 markdown */
  async function sendImages(session, keys) {
    const elements = imageElements(keys)
    if (elements.length) await session.send(elements)
  }

  async function sendCard(session, card, fallback) {
    const sent = await session.send(card)
    if (Array.isArray(sent) && sent.length) return
    logger.warn('授权按钮消息发送失败（%s），已改发纯文本', session.platform)
    await session.send(fallback)
  }

  async function askGroupCode(session, parsed) {
    const example = `${commandText}123456789`
    const lines = []
    if (parsed.reason === 'invalid') lines.push(`「${parsed.input}」不是有效的群号（5～12 位数字）。`)
    lines.push(`请带上要授权的群号，例如：${example}（群里需 @机器人，点下方按钮会自动带上）`)
    lines.push('群号在「群聊设置」页群名下方（见上图），长按可复制。')
    lines.push('授权只能由群主完成，每个群授权一次即可。')
    await sendImages(session, ['groupCode'])
    if (session.platform !== 'qq') {
      await session.send(lines.join('\n'))
      return
    }
    await sendCard(session, h('message',
      ...lines.map((line) => h('p', line)),
      h('button-group', h('button', { type: 'input', text: commandText, class: 'primary' }, '填写群号')),
    ), lines.join('\n'))
  }

  async function sendAuthorize(session, groupCode, identity) {
    const url = buildTransferUrl({ groupCode, botUin: identity.botUin, botUid: identity.botUid })
    const lines = [
      `群 ${groupCode} 的授权页已生成。`,
      '仅群主可完成授权，需要手机 QQ 9.2.90 及以上。',
      '打开后：消息范围选「获取群内全部消息」，打开「机器人主动在群聊内发言」，再点「同意授权」。',
      '打不开时按第二张图：群成员列表 → 机器人资料页 → 右上角齿轮，手动设置。',
    ]
    await sendImages(session, ['authorize', 'manual'])
    if (session.platform !== 'qq') {
      await session.send([...lines, `授权页：${url}`].join('\n'))
      return
    }
    // 官方机器人不能在正文里发链接，失败时的纯文本兜底只给手动设置的办法
    const fallback = [
      `群 ${groupCode}：授权按钮发送失败。`,
      '请群主按上图手动设置：群成员列表 → 机器人资料页 → 右上角齿轮 → 消息范围选「获取群内全部消息」，并打开「机器人主动在群聊内发言」。',
    ].join('\n')
    // 两个按钮放在同一个 button-group：适配器会在相邻 button-group 之间生成空行 { buttons: [] }
    await sendCard(session, h('message',
      ...lines.map((line) => h('p', line)),
      h('button-group',
        h('button', { type: 'link', href: url, class: 'primary' }, '群主点此授权'),
        h('button', { type: 'input', text: commandText }, '换个群号'),
      ),
    ), fallback)
  }

  return ctx.command(`${options.command} [groupCode:text]`, COMMAND_DESCRIPTION)
    .alias('qqauth')
    .action(async ({ session }, groupCode) => {
      if (!session) return
      const identity = validateIdentity(options)
      if (!identity.ok) {
        logger.warn('授权指令配置错误：%s', identity.message)
        return `授权功能配置有误：${identity.message}`
      }
      const parsed = normalizeGroupCode(groupCode)
      try {
        if (!parsed.ok) await askGroupCode(session, parsed)
        else await sendAuthorize(session, parsed.groupCode, identity)
      } catch (error) {
        logger.warn('授权指令执行失败：%s', error && error.message)
        return `生成授权按钮失败：${(error && error.message) || error}`
      }
    })
}

module.exports = {
  ASSETS,
  DEFAULTS,
  DEFAULT_BOT_UIN,
  DEFAULT_BOT_UID,
  DEFAULT_COMMAND,
  COMMAND_DESCRIPTION,
  TRANSFER_ENDPOINT,
  TRANSFER_PAGE,
  normalizeGroupCode,
  validateIdentity,
  buildTransferUrl,
  resolveOptions,
  loadImages,
  registerAuthorizeCommand,
}
