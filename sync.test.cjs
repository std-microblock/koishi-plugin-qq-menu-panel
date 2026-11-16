'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const api = require('./api.cjs')
const sync = require('./sync.cjs')

test('planMenu：空配置与空平台视为一致，字段顺序/缺省不影响判断', () => {
  assert.equal(sync.planMenu({ version: 40, menu: {} }, { items: [] }).changed, false)
  assert.equal(sync.planMenu({ version: 40 }, api.normalizeMenu({ items: [] })).changed, false)

  const desired = api.normalizeMenu({ items: [{ type: 'send_message', name: '帮助', sendMessage: '!help' }] })
  const remote = { version: 41, menu: { items: [{ name: '帮助', send_message: '!help', type: 'send_message' }] } }
  const plan = sync.planMenu(remote, desired)
  assert.equal(plan.changed, false)
  assert.equal(plan.remoteVersion, 41)

  assert.equal(sync.planMenu(remote, api.normalizeMenu({ items: [{ type: 'link', name: '官网', link: 'https://a.com' }] })).changed, true)
})

test('normalizePanelConfig：备注来自前缀+key，可选自定义', () => {
  const base = { key: 'help', scope: 'c2c', items: [{ type: 'command', name: '!help' }] }
  const panel = sync.normalizePanelConfig(base, 0, { remarkPrefix: 'koishi:' })
  assert.equal(panel.remark, 'koishi:help')
  assert.equal(panel.targetType, 'all')
  assert.deepEqual(panel.panel, { items: [{ type: 'command', name: '!help', only_admin: false }], remark: 'koishi:help' })
  assert.deepEqual(panel.userOpenIds, [])
  assert.deepEqual(panel.groupOpenIds, [])

  const custom = sync.normalizePanelConfig({ ...base, remark: 'custom-key' }, 1, {})
  assert.equal(custom.remark, 'custom-key')

  assert.throws(() => sync.normalizePanelConfig({ scope: 'c2c', items: [] }, 2, {}), /缺少 key/)
  assert.throws(() => sync.normalizePanelConfig({ key: '中文', scope: 'c2c', items: [] }, 3, {}), /key 只能包含/)
  assert.throws(
    () => sync.normalizePanelConfig({ key: 'x', scope: 'c2c', items: [{ type: 'link', name: '官网', link: 'http://a.com' }] }, 4, {}),
    /https/,
  )
})

test('matchPanels：默认按备注匹配，绑定 panelId 时按 ID 匹配', () => {
  const records = [
    { panel_id: 'p1', scope: 'c2c', target_type: 'all', panel: { items: [], remark: 'koishi:help' } },
    { panel_id: 'p2', scope: 'group', target_type: 'all', panel: { items: [], remark: 'koishi:sign' } },
  ]
  const byRemark = sync.matchPanels([sync.normalizePanelConfig({ key: 'sign', scope: 'group', items: [] }, 0, {})], records)
  assert.equal(byRemark[0].record.panel_id, 'p2')

  const byId = sync.matchPanels(
    [sync.normalizePanelConfig({ key: 'other', remark: 'not-managed', panelId: 'p1', scope: 'c2c', items: [] }, 0, {})],
    records,
  )
  assert.equal(byId[0].record.panel_id, 'p1')

  const missing = sync.matchPanels([sync.normalizePanelConfig({ key: 'new', scope: 'c2c', items: [] }, 0, {})], records)
  assert.equal(missing[0].record, undefined)
})

test('diffOpenIds：分别给出需要新增与移除的 openid', () => {
  assert.deepEqual(sync.diffOpenIds(['A', 'B'], ['B', 'C']), { add: ['A'], del: ['C'] })
  assert.deepEqual(sync.diffOpenIds([], ['C']), { add: [], del: ['C'] })
  assert.deepEqual(sync.diffOpenIds(['A'], []), { add: ['A'], del: [] })
})

test('planPanels：新建/更新/无需修改/关联对象增删', () => {
  const panel = sync.normalizePanelConfig({
    key: 'group-help',
    scope: 'group',
    targetType: 'specific',
    groupOpenIds: ['B'],
    items: [{ type: 'command', name: '!new' }],
  }, 0, {})

  const created = sync.planPanels({ matches: [{ panel, record: undefined }], details: new Map(), records: [] })
  assert.deepEqual(created.map((action) => action.type), ['create'])

  const record = {
    panel_id: 'p1',
    scope: 'group',
    target_type: 'specific',
    panel: { items: [{ type: 'command', name: '!old', only_admin: false }], remark: 'koishi:group-help' },
  }
  const details = new Map([['p1', { panel_id: 'p1', group_openids: ['A'] }]])
  const planned = sync.planPanels({ matches: [{ panel, record }], details, records: [record] })
  assert.deepEqual(planned.map((action) => action.type), ['update', 'target', 'target'])
  assert.equal(planned[1].op, 'add')
  assert.deepEqual(planned[1].openIds, ['B'])
  assert.equal(planned[2].op, 'del')
  assert.deepEqual(planned[2].openIds, ['A'])

  const same = sync.normalizePanelConfig({
    key: 'group-help',
    scope: 'group',
    targetType: 'specific',
    groupOpenIds: ['A'],
    items: [{ type: 'command', name: '!old' }],
  }, 0, {})
  const unchanged = sync.planPanels({ matches: [{ panel: same, record }], details, records: [record] })
  assert.deepEqual(unchanged.map((action) => action.type), ['unchanged'])
})

test('planPanels：作用范围不匹配时删除后重建', () => {
  const panel = sync.normalizePanelConfig({ key: 'k', scope: 'c2c', items: [] }, 0, {})
  const record = { panel_id: 'p9', scope: 'c2c', target_type: 'specific', panel: { items: [], remark: 'koishi:k' } }
  const actions = sync.planPanels({ matches: [{ panel, record }], details: new Map(), records: [record] })
  assert.deepEqual(actions.map((action) => action.type), ['recreate'])
  assert.equal(actions[0].panelId, 'p9')
  assert.match(actions[0].reason, /specific/)
})

test('planPanels：生效场景变化时删除后重建', () => {
  const panel = sync.normalizePanelConfig({ key: 'k', scope: 'group', items: [] }, 0, {})
  const record = { panel_id: 'p8', scope: 'c2c', target_type: 'all', panel: { items: [], remark: 'koishi:k' } }
  const actions = sync.planPanels({ matches: [{ panel, record }], details: new Map(), records: [record] })
  assert.deepEqual(actions.map((action) => action.type), ['recreate'])
  assert.match(actions[0].reason, /c2c 改为 group/)
})

test('planPanels：prune 只删除带前缀且未被配置认领的面板', () => {
  const records = [
    { panel_id: 'p_keep', scope: 'c2c', target_type: 'all', panel: { items: [], remark: 'koishi:help' } },
    { panel_id: 'p_gone', scope: 'c2c', target_type: 'all', panel: { items: [], remark: 'koishi:gone' } },
    { panel_id: 'p_manual', scope: 'c2c', target_type: 'all', panel: { items: [], remark: '手工配置' } },
  ]
  const panel = sync.normalizePanelConfig({ key: 'help', scope: 'c2c', items: [] }, 0, {})
  const actions = sync.planPanels({
    matches: [{ panel, record: records[0] }],
    details: new Map(),
    records,
    remarkPrefix: 'koishi:',
    prune: true,
  })
  assert.deepEqual(actions.filter((action) => action.type === 'delete').map((action) => action.panelId), ['p_gone'])

  const withoutPrune = sync.planPanels({ matches: [{ panel, record: records[0] }], details: new Map(), records })
  assert.equal(withoutPrune.filter((action) => action.type === 'delete').length, 0)
})

test('stableStringify：键顺序无关', () => {
  assert.equal(sync.stableStringify({ a: 1, b: { c: 2, d: 3 } }), sync.stableStringify({ b: { d: 3, c: 2 }, a: 1 }))
})