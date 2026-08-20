// 临时回归测试：验证菜品库下拉刷新改造（跑完即删）
const fs = require('fs')
const path = require(pathIsWin())
function pathIsWin() { return 'path' }

const PAGE_JS = 'e:/develop/sanqi-meal/miniprogram/pages/dishes/index.js'
const PAGE_WXML = 'e:/develop/sanqi-meal/miniprogram/pages/dishes/index.wxml'
const PAGE_JSON = 'e:/develop/sanqi-meal/miniprogram/pages/dishes/index.json'

let pass = 0, fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name) }
}

/* ---------- 1. 结构断言：bug 机制层面必须根除 ---------- */
console.log('[1] wxml/json/js 结构断言')
const wxml = fs.readFileSync(PAGE_WXML, 'utf8')
const json = fs.readFileSync(PAGE_JSON, 'utf8')
const jssrc = fs.readFileSync(PAGE_JS, 'utf8')

ok(!/refresher/.test(wxml), 'wxml 无 refresher 相关属性（scroll-view refresher 已根除）')
ok(!/scroll-into-view/.test(wxml), 'wxml 无 scroll-into-view')
ok(!/scrollIntoId|refresherTriggered|_scrollSeq/.test(jssrc), 'js 无 scrollIntoId/refresherTriggered/_scrollSeq 残留')
ok(/onPullDownRefresh/.test(jssrc), 'js 已实现原生 onPullDownRefresh')
ok(/stopPullDownRefresh/.test(jssrc), 'js 刷新结束调用 stopPullDownRefresh')
const conf = JSON.parse(json)
ok(conf.enablePullDownRefresh === true, '页面 json 开启 enablePullDownRefresh')

/* ---------- 2. 加载真实 index.js，mock 宿主环境 ---------- */
console.log('[2] 逻辑仿真（mock wx/Page/getApp，执行真实页面代码）')
const calls = []  // 记录 wx API 调用序列
let pageObj = null

global.wx = {
  pageScrollTo: (o) => calls.push(['pageScrollTo', o.scrollTop, o.duration]),
  stopPullDownRefresh: () => calls.push(['stopPullDownRefresh']),
  showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
  navigateTo: () => {}, cloud: { callFunction: async () => ({ result: { success: true, ver: 1 } }) }
}
const appMock = {
  globalData: { lastPullTs: 0, dishStore: { dishes: [] }, categories: [] },
  syncOnShow: async (page, opt) => { calls.push(['syncOnShow', !!(opt && opt.force)]) },
  loadUserInfo: async () => {}, getPartnerName: () => '对象',
  setKitchenTitle: () => {}, checkRenderSeq: () => false, markRenderSeq: () => {},
  isBound: () => true
}
global.getApp = () => appMock
global.Page = (o) => { pageObj = o }

// 拦截 require('../../utils/imageCache.js')
const Module = require('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request.includes('imageCache')) return { resolve: () => '' }
  return origLoad.apply(this, arguments)
}
require(PAGE_JS)

ok(!!pageObj, 'index.js 正常加载（无语法/引用错误）')

// 构造 page 实例
const inst = Object.create(pageObj)
inst.data = JSON.parse(JSON.stringify(pageObj.data))
inst.setData = function (p) { Object.assign(this.data, p) }

;(async () => {
  /* 2a. 正常下拉刷新：首次触发（lastPullTs=0 距今极久） */
  calls.length = 0
  await inst.onPullDownRefresh()
  ok(calls.some(c => c[0] === 'syncOnShow' && c[1] === true), '正常刷新：syncOnShow 以 force=true 拉取')
  ok(calls.some(c => c[0] === 'pageScrollTo' && c[1] === 0), '正常刷新：renderFromStore(resetState) 触发回顶 pageScrollTo(0)')
  ok(calls.filter(c => c[0] === 'stopPullDownRefresh').length >= 1, '正常刷新：finally 调 stopPullDownRefresh（loading 不卡死）')

  /* 2b. 3 秒防抖：紧接着再触发，应立即停止、不拉数据 */
  calls.length = 0
  await inst.onPullDownRefresh()
  ok(calls.length === 1 && calls[0][0] === 'stopPullDownRefresh', '防抖：3s 内重复触发 → 仅 stopPullDownRefresh，不再拉取')

  /* 2c. 异常路径：syncOnShow 抛错，finally 仍必须收起 loading */
  appMock.globalData.lastPullTs = 0
  const origSync = appMock.syncOnShow
  appMock.syncOnShow = async () => { throw new Error('network down') }
  let threw = false
  calls.length = 0
  try { await inst.onPullDownRefresh() } catch (e) { threw = true }
  appMock.syncOnShow = origSync
  ok(!threw, '异常路径：内部错误被捕获，不向外抛')
  ok(calls.some(c => c[0] === 'stopPullDownRefresh'), '异常路径：finally 仍 stopPullDownRefresh（loading 不卡死）')

  /* 2d. 切分类/搜索回顶走 pageScrollTo */
  calls.length = 0
  inst.selectCategory({ currentTarget: { dataset: { id: 'meat' } } })
  ok(calls.some(c => c[0] === 'pageScrollTo' && c[1] === 0), '切换分类：回顶 pageScrollTo(0) 生效')
  ok(inst.data.currentCategory === 'meat', '切换分类：currentCategory 正确更新')

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail > 0 ? 1 : 0)
})()
