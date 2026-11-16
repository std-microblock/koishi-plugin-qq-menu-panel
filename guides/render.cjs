'use strict'

// 把 guides/*.html 渲染成 assets/*.png（插件随包以 data:image/png 发送的示意图）。
//
// 用法：
//   npm i -D puppeteer-core
//   node guides/render.cjs
//
// 依赖本机已有的 Chrome / Chromium（可用环境变量 CHROME_PATH 指定可执行文件）。
// 模板里的机器人痕迹全部是占位符，渲染时可以替换成自己的机器人：
//   BOT_NAME   机器人昵称（默认「机器人」）
//   BOT_AVATAR 头像文字（默认取 BOT_NAME 的第一个字）
//   BOT_UIN    机器人 QQ 号（默认「123456789」）
// 环境变量只影响生成的示意图，不会写回模板文件。

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const here = __dirname
const outDir = path.join(here, '..', 'assets')
const pages = ['authorize-guide', 'manual-guide', 'group-code-guide']

const BOT_NAME = process.env.BOT_NAME || '机器人'
const BOT_AVATAR = process.env.BOT_AVATAR || BOT_NAME.slice(0, 1) || '机'
const BOT_UIN = process.env.BOT_UIN || '123456789'

function loadPuppeteer() {
  try {
    return require('puppeteer-core')
  } catch {
    throw new Error('找不到 puppeteer-core：请先执行 npm i -D puppeteer-core')
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  // Playwright 下载的 Chromium
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.LOCALAPPDATA || process.env.HOME || '', 'ms-playwright')
  if (fs.existsSync(root)) {
    for (const dir of fs.readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const exe = path.join(root, dir, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  throw new Error('找不到 Chrome/Chromium：请设置环境变量 CHROME_PATH')
}

/** 把模板里的占位符换成具体值，写到模板同目录的临时文件（这样 guide.css 能正常加载）。 */
function materialize(name) {
  const source = fs.readFileSync(path.join(here, `${name}.html`), 'utf8')
  const rendered = source
    .replaceAll('{{BOT_NAME}}', BOT_NAME)
    .replaceAll('{{BOT_AVATAR}}', BOT_AVATAR)
    .replaceAll('{{BOT_UIN}}', BOT_UIN)
  const temp = path.join(here, `.${name}.rendered.html`)
  fs.writeFileSync(temp, rendered, 'utf8')
  return temp
}

async function main() {
  const puppeteer = loadPuppeteer()
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 1040, deviceScaleFactor: 1 })
    for (const name of pages) {
      const temp = materialize(name)
      try {
        await page.goto(pathToFileURL(temp).href, { waitUntil: 'load' })
        await page.evaluate(() => document.fonts.ready)
        const file = path.join(outDir, `${name}.png`)
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1600, height: 1040 } })
        console.log(`${name}.png ${fs.statSync(file).size} bytes`)
      } finally {
        fs.unlinkSync(temp)
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
