# koishi-plugin-qq-menu-panel

[![npm](https://img.shields.io/npm/v/koishi-plugin-qq-menu-panel?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-qq-menu-panel)
[![license](https://img.shields.io/npm/l/koishi-plugin-qq-menu-panel?style=flat-square)](LICENSE)

QQ 官方机器人「自定义菜单」与「指令面板」适配（Koishi 插件，纯 CommonJS，不需要编译），
附带群主授权指令 `/授权全消息 <群号>`。

- 平台文档：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/>
- 接口：`GET/PUT /v2/menu`、`GET/POST /v2/panels`、`GET/PUT/DELETE /v2/panels/{panel_id}`、`PUT /v2/panels/{panel_id}/target`
- 上游 `@satorijs/adapter-qq` 没有实现这两个功能（平台侧接口较新），因此本插件以
  「本地插件扩展适配器接口面」的方式实现：把下面这些方法挂到 QQ 机器人的 `bot.internal`，
  并提供 `ctx.qqMenuPanel` 服务；所有请求都走 `bot.http`，插件自己不保存任何凭据。

## 安装

```bash
npm i koishi-plugin-qq-menu-panel
# 或 yarn / pnpm；也可以在 Koishi 控制台的「插件市场」里搜索 qq-menu-panel
```

需要 Koishi `^4.18.11` 与 QQ 官方机器人适配器（`@koishijs/plugin-adapter-qq`）。

## 功能

1. **配置式同步**：在 `koishi.yml` / 控制台里声明菜单项与面板，机器人上线后自动与平台对齐。
   - 先读平台现状再决定是否下发，内容一致时**不发请求**（菜单写入限频 5 次/分钟、面板 10 次/分钟）。
   - 平台限频（`err_code 40023001`）时立即停止本次剩余写操作并给出提示，下次同步继续。
   - 只管理带备注前缀（默认 `koishi:`）的面板；平台手工配置的面板不会被修改，`prune` 默认关闭。
   - 配置为空且 `allowEmptyMenu=false` 时不会下发空菜单，避免清掉平台已有菜单。
   - 平台不支持修改面板的生效场景与作用范围，因此这两项与配置不一致时插件会**先删除再重建**同一个面板。
   - **指令面板默认按 Koishi 命令注册表自动生成**（`panels[].source: commands`）：读取命令名/别名
     （优先中文标签）+ i18n 描述（`commands.<name>.description`）生成面板元素，前缀取 Koishi 的 `prefix` 配置。
     跳过 hidden、`slash=false`、权限高于 `maxAuthority` 的命令；子命令默认不收录；
     默认排除本插件自身的 `qqmenu*` / `qqpanel*` / `qqsync`。
2. **适配器接口面**：把以下方法挂到 QQ 机器人的 `bot.internal`（若适配器将来原生实现同名方法则不覆盖），
   同时提供 `ctx.qqMenuPanel` 服务：

   | 方法 | 平台接口 |
   | --- | --- |
   | `getMenu()` / `updateMenu(menu)` | `GET` / `PUT /v2/menu` |
   | `getPanels({ scope, cursor, limit })` | `GET /v2/panels` |
   | `getAllPanels(scope)` | 分页拉取某场景全部面板 |
   | `createPanel({ scope, targetType, userOpenIds, groupOpenIds, panel })` | `POST /v2/panels` |
   | `getPanel(panelId)` / `updatePanel(panelId, panel)` / `deletePanel(panelId)` | `/v2/panels/{id}` |
   | `updatePanelTarget(panelId, { op, userOpenIds, groupOpenIds })` | `PUT /v2/panels/{id}/target` |

3. **管理指令**：`qqmenu`（查看菜单与差异）、`qqmenu.sync`（下发菜单）、`qqpanel`（列表面板）、
   `qqpanel.group` / `面板群号`（查当前群 OpenID 与面板匹配情况）、`qqpanel.sync`（下发面板）、
   `qqpanel.delete <panel_id>`、`qqsync`（同时下发）。
   默认要求 `adminUserIds` 命中或权限等级 ≥ `manageAuthority`（默认 4）。
4. **群主授权指令 `/授权全消息 <群号>`**（别名 `qqauth`，所有群、所有成员可触发，见下一节）。

## 群主授权：`/授权全消息 <群号>`

让官方机器人在某个群「获取群内全部消息」（不用 @ 也能收到）并允许「主动在群聊内发言」。

- **机器人身份由配置提供**：QQ 号与 UID 填在 `authorize.botUin` / `authorize.botUid`。
  插件**不内置任何机器人身份**，也不查询本地客户端的接口。
- **用 link 按钮跳转**：回复里的「群主点此授权」是 `type=link` 按钮，指向
  `https://club.vip.qq.com/transfer?open_kuikly_info=<encodeURIComponent(JSON)>`，
  JSON 为 `{"page_name":"ai_group_service_agreement_pop_page","groupCode":<群号>,"botUin":<QQ号>,"botUid":"<UID>","screen":1}`。
  正文不含链接（官方机器人发裸链接会被拦截）；非 QQ 平台才以纯文本附上地址。
- **参数是群号**：官方机器人只能拿到群 openid、拿不到真实群号，所以由用户填写；每个群授权一次即可，不做记忆。
  支持全角数字与空格，5～12 位数字；不带参数或格式错误时回复「怎么找到群号」教程图 + 「填写群号」按钮。
- **按钮卡片发送失败时**改发纯文本兜底，只给手动设置路径。先发图片、再发按钮卡片
  （适配器遇到按钮会把同一次发送的内容整体转成 markdown）。
- 只有群主能完成授权（平台限制），需要手机 QQ 9.2.90 及以上；群里发指令仍要 @机器人或带前缀。
- **示意图与教程图**随插件打包在 `assets/`，以 `data:image/png;base64` 发送，不依赖外部图床：

  | 文件 | 何时发送 | 内容 |
  | --- | --- | --- |
  | `assets/authorize-guide.png` | 带群号时 | 发指令 → 群主点按钮 → 授权弹窗选「获取群内全部消息」、打开主动发言、同意授权 |
  | `assets/manual-guide.png` | 带群号时 | 按钮打不开时的手动路径：群成员列表 → 机器人资料页齿轮 → 设置 |
  | `assets/group-code-guide.png` | 缺群号 / 群号无效时 | 群聊设置里找群号，并带上群号重新发送 |

  图片由 `guides/*.html`（仿手机 QQ 界面的示意图，不含真实截图）经 `node guides/render.cjs` 生成；
  模板里的机器人昵称/头像/QQ 号都是占位符，可以用 `BOT_NAME` / `BOT_AVATAR` / `BOT_UIN` 环境变量替换成自己的。

### 怎么拿到 `botUin` / `botUid`

授权弹窗必须知道「哪个机器人」在申请权限，所以这两项是配置项。常见取法：

- **`botUin`（机器人 QQ 号）**：手机 QQ 群里 → 机器人资料页（见 `assets/manual-guide.png` 第二格），
  资料页上会直接显示机器人的 QQ 号。
- **`botUid`（`u_` 开头的 UID）**：拿任意一条已有的「群主授权」链接
  （`https://club.vip.qq.com/transfer?open_kuikly_info=...`），把 `open_kuikly_info` 的值
  `decodeURIComponent` 后就是一个 JSON，里面直接有 `botUin` 与 `botUid`；
  也可以用 QQNT / NapCat 的 `/v1/users` 之类的本地接口查询（本插件不需要这一步，只是取值方式之一）。

两项必须对应**同一个**机器人，填错时授权页会打不开或授权到别人身上。

配置示例：

```yaml
plugins:
  qq-menu-panel:
    authorize:
      enabled: true
      command: 授权全消息        # 指令名，改完需要重载插件
      botUin: '1234567890'      # 你的机器人 QQ 号
      botUid: u_XXXXXXXXXXXXXXXXXXXX  # 同一个机器人的 UID
      inputPrefix: /            # 「填写群号」「换个群号」按钮预填的前缀
      sendImages: true          # 是否随回复发送示意图 / 教程图
```

## 不同群用不同的指令面板

平台支持按群生效：`scope: group` + `targetType: specific` + `groupOpenIds`。给每个群（或每组群）写一个面板条目、
用 `include` / `exclude` 决定该群显示哪些命令即可；面板归属仍以备注前缀 `koishi:` 标记，`groupOpenIds` 的增删会自动用
`PUT /v2/panels/{id}/target` 对齐。在目标群里发 `qqpanel.group`（别称 `面板群号`，需管理权限）会返回该群的 OpenID
以及各面板是否匹配。

```yaml
plugins:
  qq-menu-panel:
    panels:
      - key: group-a            # 单群专用：只显示这几个命令
        scope: group
        targetType: specific
        groupOpenIds: ['<A 群 openid>']
        source: commands
        prefixMode: none
        include: [抽奖, 一言, 帮助]
      - key: group-b            # 另一个群：完全不同的内容
        scope: group
        targetType: specific
        groupOpenIds: ['<B 群 openid>']
        source: commands
        prefixMode: none
        include: [查询, 排行, 帮助]
```

- 平台限制：一个机器人最多 20 个面板；一个 specific 面板最多关联 1000 个 openid（每次请求最多 20 个）。
- 若同时存在 `targetType: all` 的 group 面板，平台会把它和 specific 面板一起生效（多面板并存）；
  想让不同群显示**完全不同**的内容时，建议不要保留 all 的 group 面板，只保留按群配置的 specific 面板。

## 配置要点

| 字段 | 说明 |
| --- | --- |
| `botSelfId` | 限定机器人 selfId，留空对全部 `platform=qq` 机器人生效 |
| `autoSync` | 上线后自动对齐（默认开）；关闭后只能手动 `qqsync` |
| `dryRun` | 只计算并打印差异，不写平台 |
| `prune` | 删除带备注前缀但配置已移除的面板（默认关） |
| `allowEmptyMenu` | 配置为空时也下发空菜单（默认关，防止误清） |
| `remarkPrefix` | 面板备注前缀，也是「本插件管理」的识别依据（默认 `koishi:`） |
| `adminUserIds` | 可执行管理指令的用户 ID，支持 `userId` 或 `platform:userId` |
| `manageAuthority` | 未列入 `adminUserIds` 时执行管理指令所需的最低权限等级（默认 4） |
| `menu.items[]` | `type`：`send_message` / `link` / `switch` / `menu`；名称 ≤ 10 字符（中文算 2） |
| `panels[].source` | `commands`（默认，按命令注册表自动生成）/ `manual`（用 `items` 手填） |
| `panels[].include` | `source=commands`：命中的命令优先展示（支持 `*` 通配），显式列出的子命令也会收录 |
| `panels[].exclude` | `source=commands`：排除的命令（支持 `*` 通配） |
| `panels[].subcommands` | `source=commands`：是否收录子命令（如 `raffle.create`），默认否 |
| `panels[].maxAuthority` | `source=commands`：只收录最低权限 ≤ 该值的命令（默认 3） |
| `panels[].adminAuthority` | `source=commands`：权限 ≥ 该值的命令标记为「仅频道/群管理员可点击」（默认 3） |
| `panels[].maxItems` | 元素总数上限（含 `extraItems`），默认 20 |
| `panels[].prefixMode` | `koishi`（默认，取 Koishi 的 `prefix`）/ `custom`（用 `prefix`）/ `none`（只写命令名） |
| `panels[].prefix` | `prefixMode=custom` 时使用的前缀 |
| `panels[].extraItems` | `source=commands`：自动生成之外追加的元素（链接等） |
| `panels[].key` | 本地标识，默认生成备注 `koishi:<key>` 并据此匹配平台面板 |
| `panels[].scope` | `c2c` / `group` / `channel` / `dm` |
| `panels[].targetType` | `all` 或 `specific`（`specific` 仅支持 c2c/group，需给 `userOpenIds` 或 `groupOpenIds`） |
| `panels[].items[]` | `source=manual` 时的元素：`type` 为 `command`（点击填入输入框）/ `link`；名称 ≤ 14、描述 ≤ 30 字符 |

平台限制会先本地校验并给出中文提示，例如菜单项 ≤ 10、子菜单 ≤ 5、面板 ≤ 20 个、面板元素 ≤ 20 个、
`link` 必须以 `https://` 开头。

## 目录

- `index.cjs`：Koishi 插件（配置 schema、`ctx.qqMenuPanel`、`bot.internal` 挂载、管理指令、自动同步）
- `api.cjs`：接口封装、字段校验与「平台形态」规整（camelCase / snake_case 均可作为输入）
- `sync.cjs`：差异计算（纯函数）
- `commands.cjs`：按 Koishi 命令注册表生成指令面板元素（过滤/排序/长度截断）
- `authorize.cjs`：群主授权指令 `/授权全消息`（授权页地址生成、群号校验、按钮与教程图）
- `assets/`：随包发送的授权示意图与教程图
- `guides/`：上述图片的 HTML 模板与渲染脚本（`node guides/render.cjs`）
- `*.test.cjs`：单元测试（`node --test`）

## 开发

```bash
npm i           # 需要 koishi（peerDependency）才能跑单元测试
npm test        # node --test
```

## License

MIT
