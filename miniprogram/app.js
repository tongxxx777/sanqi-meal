// 全局页面绑定拦截器 - 白名单之外的页面自动校验绑定状态
const _originalPage = Page
const _bindWhitelist = [
  'pages/index/index',
  'pages/settings/index',
  'pages/bind/index',
  'pages/bind-confirm/index'
]

Page = function(options) {
  const originalOnShow = options.onShow
  options.onShow = async function(...args) {
    const app = getApp()
    const pages = getCurrentPages()
    const route = pages[pages.length - 1]?.route || ''
    const whitelisted = _bindWhitelist.some(w => route.includes(w))

    if (!whitelisted && app && app.bindGuard) {
      // 等待全局用户信息加载完成后再校验绑定状态
      // loadUserInfo 有缓存，已加载时立即返回，不影响性能
      if (typeof app.loadUserInfo === 'function') {
        await app.loadUserInfo()
      }
      app.bindGuard(this)
    }

    if (originalOnShow) {
      return originalOnShow.apply(this, args)
    }
  }
  _originalPage(options)
}

App({
  async onLaunch() {
    this.initcloud()

    // 全局启用分享菜单（转发 + 朋友圈）
    wx.showShareMenu({
      withShareTicket: false,
      menus: ['shareAppMessage', 'shareTimeline']
    })

    this.globalData = {
      // 当前用户信息(动态获取)
      currentUser: null,
      // 伴侣信息(动态获取)
      partner: null,
      // 用户信息是否已加载
      userLoaded: false,
      // 用户信息加载Promise
      userLoadPromise: null,

      // 云数据库集合名称
      collectionDishList: 'DishList',
      collectionOrderList: 'OrderList',

      // 应用信息
      appName: '叁柒食',
      version: '1.0.0',

      // 菜品分类(从数据库动态加载)
      categories: [],
      categoriesLoaded: false,
      categoriesLoadPromise: null,
      categoriesInited: false,

      // 下拉刷新节流（全局，防连续手抖下拉）
      lastPullTs: 0,
    }

    // 预加载用户信息：在系统启动画面期间拉取数据，首页加载时缓存命中，几乎零等待
    // 不阻塞 onLaunch 返回，异步执行；若未完成则首页 loading 兜底
    this.loadUserInfo().catch(e => console.error('preload user info error', e))
  },

  /**
   * 初始化云开发环境
   */
  async initcloud() {
    const normalinfo = require('./envList.js').envList || []
    if (normalinfo.length != 0 && normalinfo[0].envId != null) {
      wx.cloud.init({
        traceUser: true,
        env: normalinfo[0].envId
      })
      this.cloud = () => {
        return wx.cloud
      }
    } else {
      this.cloud = () => {
        wx.showModal({
          content: '找不到云环境',
          showCancel: false
        })
        throw new Error('无云开发环境')
      }
    }
  },

  // 获取云数据库实例
  async database() {
    return (await this.cloud()).database()
  },

  // 加载用户信息(带缓存)
  async loadUserInfo(forceRefresh = false) {
    // 如果已加载且不强制刷新，直接返回
    if (this.globalData.userLoaded && !forceRefresh) {
      return {
        currentUser: this.globalData.currentUser,
        partner: this.globalData.partner
      }
    }

    // 如果正在加载中，等待加载完成
    if (this.globalData.userLoadPromise && !forceRefresh) {
      return this.globalData.userLoadPromise
    }

    // 开始加载
    this.globalData.userLoadPromise = this._doLoadUserInfo()
    return this.globalData.userLoadPromise
  },

  // 实际加载用户信息
  async _doLoadUserInfo() {
    try {
      const res = await wx.cloud.callFunction({ name: 'createUser' })
      if (res.result && res.result.success) {
        this.globalData.currentUser = res.result.user
        this.globalData.partner = res.result.partner
        this.globalData.userLoaded = true
        // 已绑定时预热分类，不阻塞首屏展示
        if (res.result.user?.bindStatus === 'bound') {
          this.loadCategories().catch(e => console.error('preload categories error', e))
        }
        return {
          currentUser: res.result.user,
          partner: res.result.partner
        }
      }
    } catch (e) {
      console.error('load user info error', e)
    }
    return { currentUser: null, partner: null }
  },

  // 加载分类数据
  async loadCategories(forceRefresh = false) {
    if (this.globalData.categoriesLoaded && !forceRefresh) {
      return this.globalData.categories
    }

    if (this.globalData.categoriesLoadPromise && !forceRefresh) {
      return this.globalData.categoriesLoadPromise
    }

    this.globalData.categoriesLoadPromise = this._doLoadCategories(forceRefresh)
    try {
      return await this.globalData.categoriesLoadPromise
    } finally {
      this.globalData.categoriesLoadPromise = null
    }
  },

  async _doLoadCategories(forceRefresh = false) {
    try {
      // 优先读 storage 缓存，避免冷启动重复跑 init
      const coupleId = this.globalData.currentUser?.coupleId
      const cacheKey = 'categories_' + (coupleId || 'default')
      if (!forceRefresh) {
        try {
          const cached = wx.getStorageSync(cacheKey)
          if (cached && Array.isArray(cached) && cached.length > 0) {
            this.globalData.categories = cached
            this.globalData.categoriesLoaded = true
            this.globalData.categoriesInited = true
            return cached
          }
        } catch (e) { /* ignore read error */ }
      }

      // 先确保初始化默认分类
      if (!this.globalData.categoriesInited || forceRefresh) {
        await wx.cloud.callFunction({
          name: 'manageCategory',
          data: { action: 'init' }
        })
        this.globalData.categoriesInited = true
      }
      // 加载分类列表
      const res = await wx.cloud.callFunction({
        name: 'manageCategory',
        data: { action: 'list' }
      })
      if (res.result?.success) {
        this.globalData.categories = res.result.data
        this.globalData.categoriesLoaded = true
        try {
          wx.setStorageSync(cacheKey, res.result.data)
        } catch (e) { /* ignore write error */ }
        return res.result.data
      }
    } catch (e) {
      console.error('load categories error', e)
    }
    return []
  },

  // ========== 强制刷新基础数据 ==========
  // 下拉刷新统一入口：清空所有内存 + storage 缓存，然后拉最新分类
  forceRefreshBase() {
    // 1. 清除 storage 分类缓存
    try {
      const coupleId = this.globalData.currentUser?.coupleId
      if (coupleId) wx.removeStorageSync('categories_' + coupleId)
      wx.removeStorageSync('categories_default')
    } catch (e) { /* ignore */ }
    // 2. 重置内存中的分类状态（破坏所有缓存守卫）
    this.globalData.categories = []
    this.globalData.categoriesLoadPromise = null
    this.globalData.categoriesLoaded = false
    this.globalData.categoriesInited = false
    // 3. 强制从云函数拉最新分类（跳过内存 + storage 两层缓存）
    return this.loadCategories(true)
  },

  // 绑定伴侣
  async bindPartner(inviteCode) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'bindPartner',
        data: { inviteCode }
      })
      if (res.result && res.result.success) {
        // 刷新用户信息(会自动加载分类)
        await this.loadUserInfo(true)
        return { success: true, partner: res.result.partner }
      }
      return { success: false, message: res.result?.message || '绑定失败' }
    } catch (e) {
      console.error('bind partner error', e)
      return { success: false, message: '绑定失败，请重试' }
    }
  },

  // 解除绑定
  async unbindPartner() {
    try {
      const res = await wx.cloud.callFunction({ name: 'unbindPartner' })
      if (res.result && res.result.success) {
        this.globalData.partner = null
        if (this.globalData.currentUser) {
          this.globalData.currentUser.partnerId = ''
          this.globalData.currentUser.bindStatus = 'unbound'
          this.globalData.currentUser.coupleId = ''
        }
        return { success: true }
      }
      return { success: false, message: res.result?.message || '解绑失败' }
    } catch (e) {
      console.error('unbind partner error', e)
      return { success: false, message: '解绑失败，请重试' }
    }
  },

  // 检查是否已绑定伴侣
  isBound() {
    const user = this.globalData.currentUser
    if (user?.bindStatus !== 'bound') return false
    if (!this.globalData.partner) {
      console.warn('[isBound] bindStatus=bound but partner is null, data may be inconsistent')
      return false
    }
    return true
  },

  // 检查用户信息是否完整(有昵称和头像)
  isProfileComplete() {
    const user = this.globalData.currentUser
    return user?.nickname && user?.avatarUrl
  },

  // 页面绑定守卫：仅设置绑定状态到页面 data，不拦截页面展示
  bindGuard(page) {
    page.setData({ isBound: this.isBound() })
    return true
  },

  // 获取伴侣名字
  getPartnerName() {
    return this.globalData.partner?.nickname || '对方'
  },

  // 根据 openid 获取显示名称
  getDisplayName(openid) {
    if (openid === this.globalData.currentUser?._id) {
      return '你'
    }
    if (openid === this.globalData.partner?.openid) {
      return this.globalData.partner?.nickname || '对方'
    }
    return '未知'
  },

  // 获取厨房名称(自定义或默认)
  getKitchenName() {
    return this.globalData.currentUser?.kitchenName || this.globalData.appName
  },

  // 设置页面导航栏标题为厨房名称
  setKitchenTitle() {
    const title = this.getKitchenName()
    wx.setNavigationBarTitle({ title })
  },

  // 更新厨房名称(同步到伴侣)
  async updateKitchenName(name) {
    if (!name || name.length > 8) {
      return { success: false, message: '名称不能超过8个字' }
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'updateKitchenName',
        data: { kitchenName: name }
      })
      if (res.result?.success) {
        this.globalData.currentUser.kitchenName = name
        return { success: true }
      }
      return { success: false, message: res.result?.message || '更新失败' }
    } catch (e) {
      console.error('update kitchen name error', e)
      return { success: false, message: '更新失败' }
    }
  },

  // 获取菜品与订单数量统计（带 2 分钟缓存）
  async getStats() {
    const coupleId = this.globalData.currentUser?.coupleId
    const cacheKey = 'stats_' + (coupleId || 'default')
    try {
      const cached = wx.getStorageSync(cacheKey)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (Date.now() - parsed.ts < 2 * 60 * 1000) {
          return parsed.data
        }
      }
    } catch (e) { /* ignore */ }

    try {
      const [dishRes, orderRes] = await Promise.all([
        wx.cloud.callFunction({ name: 'getCoupleData', data: { collection: this.globalData.collectionDishList, countOnly: true } }),
        wx.cloud.callFunction({ name: 'getCoupleData', data: { collection: this.globalData.collectionOrderList, countOnly: true } })
      ])
      const stats = {
        dishCount: dishRes.result?.total || 0,
        orderCount: orderRes.result?.total || 0
      }
      try {
        wx.setStorageSync(cacheKey, JSON.stringify({ data: stats, ts: Date.now() }))
      } catch (e) { /* ignore */ }
      return stats
    } catch (e) {
      console.error('get stats error', e)
      return { dishCount: 0, orderCount: 0 }
    }
  },

  // ========== 全局分享配置 ==========

  /**
   * 全局转发兜底 —— 所有未自定义 onShareAppMessage 的页面走这里
   * 页面可通过定义自己的 onShareAppMessage 覆盖
   */
  onShareAppMessage(options) {
    const pages = getCurrentPages()
    const route = pages[pages.length - 1]?.route || ''

    const shareTitles = {
      'pages/index/index': this.getKitchenName() + ' · 专属小厨房',
      'pages/dishes/index': '来看看我们的小厨房菜单吧',
      'pages/order/index': '今天吃什么？来' + this.getKitchenName() + '点菜吧',
      'pages/order-history/index': '看看我们的美食记录',
      'pages/settings/index': this.getKitchenName() + ' · 专属小厨房'
    }

    return {
      title: shareTitles[route] || this.getKitchenName() + ' · 和TA的专属小厨房',
      path: '/pages/index/index',
      imageUrl: '/images/default.jpg'
    }
  },

  onShareTimeline() {
    const pages = getCurrentPages()
    const route = pages[pages.length - 1]?.route || ''

    const timelineTitles = {
      'pages/index/index': this.getKitchenName() + ' · 专属小厨房',
      'pages/dishes/index': this.getKitchenName() + ' · 我们的美食小厨房',
      'pages/order-history/index': this.getKitchenName() + ' · 美食记忆'
    }

    return {
      title: timelineTitles[route] || this.getKitchenName() + ' · 和TA的专属小厨房',
      imageUrl: '/images/default.jpg'
    }
  },
})
