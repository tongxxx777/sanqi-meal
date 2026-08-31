// 全局页面绑定拦截器 - 白名单之外的页面自动校验绑定状态
const _originalPage = Page
const _bindWhitelist = [
  'pages/index/index',
  'pages/mine/index',
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
      version: '3.0.0',

      // 菜品分类(从数据库动态加载)
      categories: [],
      categoriesLoaded: false,
      categoriesLoadPromise: null,

      // 下拉刷新节流（全局，防连续手抖下拉）
      lastPullTs: 0,

      // ========== 实时数据机制（版本号 + 写时失效缓存）==========
      // 版本校验模式：'always' 每次 onShow 校验（实时性最好）| 'launch' 仅冷启动+下拉刷新校验（省调用）
      CHECK_MODE: 'always',
      // 本地版本号（-1 表示未知，触发全量对账）
      versions: { dishVer: -1, categoryVer: -1, orderVer: -1, userVer: -1 },
      // 计数（由 CoupleMeta 维护，首页/我的页统计直接读取，不再单独发云函数）
      counts: { dishCount: 0, orderCount: 0 },
      // 菜品库（dishes 页与 order 页共享同一份数据）
      dishStore: { dishes: [], loaded: false },
      // 首页小饭桌订单原始数据（近 30 天创建，页面侧按期望用餐日过滤出今明两天）
      homeStore: { orders: [], loaded: false },
      // 历史页第一页数据（分页的第 2 页起由页面自行加载）
      historyStore: { orders: [], hasMore: true, page: 0, loaded: false },

      // 再来一单信箱：历史页写入 → order 页 onShow 消费（一次性，读完即清）
      // { ids: 菜品 id 数组, missingCount: 已不在菜单的道数 }
      pendingReorder: null,

      // 渲染序号：store 数据每变化一次（本端写回 +1，云端重拉也 +1）序号 +1
      // 每个页面独立记录"我上次渲染时的序号"，onShow 时比对，变了就重渲染。
      // 解决"本端写操作（删菜/加菜等）后版本号已同步，导致 onShow 误判无变化"的问题。
      renderSeq: { dish: 0, category: 0, order: 0, user: 0 },
    }

    // 内部状态（非渲染数据，挂在 this 上）
    this._checkPromise = null
    this._dishPromise = null
    this._bootstrapPromise = null
    this._cacheCoupleId = null
    this._checkedOnce = false

    // 一次性清理 v1 旧缓存 key
    this._cleanLegacyKeys()

    // 预加载：冷启动走 bootstrap 聚合接口，一次拿全首屏数据
    this.loadUserInfo().catch(e => console.error('preload bootstrap error', e))
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

  // ========== 冷启动聚合 ==========

  // bootstrap：一次云函数调用拿全 user+partner+分类+小饭桌订单+版本号
  async bootstrap(force = false) {
    if (this._bootstrapPromise && !force) return this._bootstrapPromise
    this._bootstrapPromise = this._doBootstrap()
    try {
      return await this._bootstrapPromise
    } finally {
      this._bootstrapPromise = null
    }
  },

  async _doBootstrap() {
    const res = await wx.cloud.callFunction({ name: 'bootstrap' })
    const r = res.result
    if (!r || !r.success) {
      throw new Error((r && r.error) || 'bootstrap failed')
    }
    const g = this.globalData
    g.currentUser = r.user
    g.partner = r.partner
    g.userLoaded = true
    if (r.bound && r.user && r.user.coupleId) {
      const coupleId = r.user.coupleId
      // 本次启动以 bootstrap 返回的最新数据为准，跳过 storage 恢复
      this._cacheCoupleId = coupleId
      g.categories = r.categories || []
      g.categoriesLoaded = true
      g.homeStore = { orders: r.orders || [], loaded: true }
      if (r.meta) this._applyMeta(r.meta)
      try { wx.setStorageSync('v2_categories_' + coupleId, g.categories) } catch (e) { /* ignore */ }
      // 冷启动全量刷新，三个维度的 store 都换，bump 让页面 onShow 重渲染
      this._bumpSeq('user')
      this._bumpSeq('category')
      this._bumpSeq('order')
    } else {
      // 未绑定也要让用户相关（如昵称）刷新
      this._bumpSeq('user')
    }
    return r
  },

  // 加载用户信息(带缓存)：冷启动由 bootstrap 支撑
  async loadUserInfo(forceRefresh = false) {
    const g = this.globalData
    if (g.userLoaded && !forceRefresh) {
      return { currentUser: g.currentUser, partner: g.partner }
    }
    if (g.userLoadPromise && !forceRefresh) {
      return g.userLoadPromise
    }
    g.userLoadPromise = (async () => {
      try {
        if (g.userLoaded && forceRefresh) {
          await this._reloadUser()
        } else if (!g.userLoaded) {
          await this.bootstrap()
        }
      } catch (e) {
        console.error('load user info error', e)
      }
      return { currentUser: g.currentUser, partner: g.partner }
    })()
    try {
      return await g.userLoadPromise
    } finally {
      g.userLoadPromise = null
    }
  },

  // 只重拉 user+partner（userVer 变化时触发；createUser 不传昵称/头像不会 inc 版本）
  async _reloadUser() {
    try {
      const res = await wx.cloud.callFunction({ name: 'createUser' })
      if (res.result?.success) {
        this.globalData.currentUser = res.result.user
        this.globalData.partner = res.result.partner
        this.globalData.userLoaded = true
        this._bumpSeq('user')
      }
    } catch (e) {
      console.error('reload user error', e)
    }
  },

  // ========== 版本校验 ==========

  // 直连读 CoupleMeta（1 次 DB 读、0 云函数），返回变化的数据类
  async checkVersions() {
    const coupleId = this.globalData.currentUser?.coupleId
    if (!coupleId) return { changed: [], meta: null }
    this._ensureLocalCache(coupleId)
    if (this._checkPromise) return this._checkPromise
    this._checkPromise = this._doCheckVersions(coupleId)
    try {
      return await this._checkPromise
    } finally {
      this._checkPromise = null
    }
  },

  async _doCheckVersions(coupleId) {
    try {
      const db = await this.database()
      const res = await db.collection('CoupleMeta').doc(coupleId).get()
      const meta = res.data
      const v = this.globalData.versions
      const changed = []
      if (v.dishVer !== meta.dishVer) changed.push('dish')
      if (v.categoryVer !== meta.categoryVer) changed.push('category')
      if (v.orderVer !== meta.orderVer) changed.push('order')
      if (v.userVer !== meta.userVer) changed.push('user')
      return { changed, meta }
    } catch (e) {
      const msg = String((e && e.errMsg) || e)
      if (/not exist|DOCUMENT_NOT_FOUND/i.test(msg)) {
        // 存量情侣无 CoupleMeta 文档 → bootstrap 懒创建并全量刷新一次
        return { changed: ['user', 'category', 'dish', 'order'], meta: null, needBootstrap: true }
      }
      // 网络等异常 → 降级读本地缓存，不阻塞页面
      console.error('checkVersions degraded', e)
      return { changed: [], meta: null, degraded: true }
    }
  },

  // 从 storage 恢复版本号与各 store（每个 coupleId 每次启动只恢复一次）
  _ensureLocalCache(coupleId) {
    if (this._cacheCoupleId === coupleId) return
    this._cacheCoupleId = coupleId
    const g = this.globalData
    try {
      const meta = wx.getStorageSync('v2_meta_' + coupleId)
      if (meta) {
        g.versions = {
          dishVer: typeof meta.dishVer === 'number' ? meta.dishVer : -1,
          categoryVer: typeof meta.categoryVer === 'number' ? meta.categoryVer : -1,
          orderVer: typeof meta.orderVer === 'number' ? meta.orderVer : -1,
          userVer: typeof meta.userVer === 'number' ? meta.userVer : -1,
        }
        g.counts = {
          dishCount: meta.dishCount || 0,
          orderCount: meta.orderCount || 0,
        }
      }
      if (!g.dishStore.loaded) {
        const dishes = wx.getStorageSync('v2_dishes_' + coupleId)
        if (Array.isArray(dishes) && dishes.length) {
          g.dishStore = { dishes, loaded: true }
        }
      }
      if (!g.categoriesLoaded) {
        const cats = wx.getStorageSync('v2_categories_' + coupleId)
        if (Array.isArray(cats) && cats.length) {
          g.categories = cats
          g.categoriesLoaded = true
        }
      }
      if (!g.historyStore.loaded) {
        const his = wx.getStorageSync('v2_history_' + coupleId)
        if (his && Array.isArray(his.orders) && his.orders.length) {
          g.historyStore = { orders: his.orders, hasMore: his.hasMore !== false, page: his.page || 1, loaded: true }
        }
      }
    } catch (e) { /* ignore storage error */ }
  },

  // 页面 onShow 统一入口：版本校验 + 按变化精准重拉 + store 兜底加载
  // scene: 'home' | 'dishes' | 'order' | 'records' | 'mine'
  async syncOnShow(scene, options = {}) {
    if (!this.isBound()) return { changed: [] }
    const coupleId = this.globalData.currentUser.coupleId
    this._ensureLocalCache(coupleId)

    let changed = []
    let meta = null
    const force = !!options.force
    const needCheck = force
      || this.globalData.CHECK_MODE === 'always'
      || !this._checkedOnce

    if (needCheck) {
      this._checkedOnce = true
      const r = await this.checkVersions()
      if (r.degraded) return { changed: [], degraded: true }
      if (r.needBootstrap) {
        await this.bootstrap(true)
        return { changed: ['user', 'category', 'dish', 'order'] }
      }
      changed = r.changed
      meta = r.meta
    }

    const g = this.globalData
    const tasks = []
    if (changed.includes('user')) tasks.push(this._reloadUser())
    if (changed.includes('category') || !g.categoriesLoaded) tasks.push(this.loadCategories(true))
    if (changed.includes('dish') || !g.dishStore.loaded) tasks.push(this.reloadDishes())
    if (changed.includes('order')) tasks.push(this.reloadOrders())
    // 场景兜底：对应 store 未加载则补齐（首次访问）
    if (scene === 'home' && !g.homeStore.loaded) tasks.push(this.reloadHome())
    if (scene === 'records' && !g.historyStore.loaded) tasks.push(this.reloadHistory())
    await Promise.all(tasks)

    // 重拉完成后再应用版本号：若期间对方又有写入，下次校验会发现版本差自动再拉
    if (meta) this._applyMeta(meta)
    return { changed }
  },

  // ========== 数据加载（全部走 store，页面不再直接调云函数拉列表）==========

  // 加载分类数据（manageCategory list 内部自动判空 init，单次调用）
  async loadCategories(forceRefresh = false) {
    const g = this.globalData
    if (g.categoriesLoaded && !forceRefresh) {
      return g.categories
    }
    if (g.categoriesLoadPromise && !forceRefresh) {
      return g.categoriesLoadPromise
    }
    g.categoriesLoadPromise = (async () => {
      try {
        const res = await wx.cloud.callFunction({
          name: 'manageCategory',
          data: { action: 'list' }
        })
        if (res.result?.success) {
          g.categories = res.result.data
          g.categoriesLoaded = true
          const coupleId = g.currentUser?.coupleId
          if (coupleId) {
            try { wx.setStorageSync('v2_categories_' + coupleId, res.result.data) } catch (e) { /* ignore */ }
          }
          this._bumpSeq('category')
        }
      } catch (e) {
        console.error('load categories error', e)
      }
      return g.categories || []
    })()
    try {
      return await g.categoriesLoadPromise
    } finally {
      g.categoriesLoadPromise = null
    }
  },

  // 重拉菜品列表（写入 dishStore，dishes/order 两页共享）
  async reloadDishes() {
    if (this._dishPromise) return this._dishPromise
    this._dishPromise = (async () => {
      try {
        const res = await wx.cloud.callFunction({
          name: 'getCoupleData',
          data: {
            collection: this.globalData.collectionDishList,
            orderBy: 'createTime',
            order: 'desc',
            limit: 300
          }
        })
        if (res.result?.success) {
          this.globalData.dishStore = { dishes: res.result.data || [], loaded: true }
          this._persistDishes()
          this._bumpSeq('dish')
        }
      } catch (e) {
        console.error('reload dishes error', e)
      }
      return this.globalData.dishStore.dishes
    })()
    try {
      return await this._dishPromise
    } finally {
      this._dishPromise = null
    }
  },

  // 重拉首页小饭桌订单原始数据（近 30 天创建）
  async reloadHome() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: this.globalData.collectionOrderList,
          sinceDays: 30,
          orderBy: 'createTime',
          order: 'desc',
          limit: 100
        }
      })
      if (res.result?.success) {
        this.globalData.homeStore = { orders: res.result.data || [], loaded: true }
        this._bumpSeq('order')
      }
    } catch (e) {
      console.error('reload home error', e)
    }
    return this.globalData.homeStore.orders
  },

  // 重拉历史第一页
  async reloadHistory() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: this.globalData.collectionOrderList,
          orderBy: 'createTime',
          order: 'desc',
          skip: 0,
          limit: 10
        }
      })
      if (res.result?.success) {
        const data = res.result.data || []
        this.globalData.historyStore = { orders: data, hasMore: data.length === 10, page: 1, loaded: true }
        this._persistHistory()
        this._bumpSeq('order')
      }
    } catch (e) {
      console.error('reload history error', e)
    }
    return this.globalData.historyStore
  },

  // orderVer 变化：首页 + 历史第一页一起重拉
  async reloadOrders() {
    await Promise.all([this.reloadHome(), this.reloadHistory()])
  },

  // 获取统计计数（读内存，由 CoupleMeta 随版本校验/写响应维护，不发云函数）
  async getStats() {
    return {
      dishCount: this.globalData.counts.dishCount,
      orderCount: this.globalData.counts.orderCount
    }
  },

  // ========== 写操作后立即更新本地（本端实时的核心）==========

  // 渲染序号 +1（store 数据真正变化一次就 +1，无论本端写回还是云端重拉）
  _bumpSeq(type) {
    if (this.globalData.renderSeq[type] === undefined) return
    this.globalData.renderSeq[type]++
  },

  // 供页面 onShow 判断是否需要在本端数据变化后重渲染
  // types: 该页面关心的 renderSeq 维度数组，如 ['dish','category','user']
  // 页面各自记录"上次渲染时的序号"到 page._renderedSeq，变化即返回 true
  checkRenderSeq(page, types) {
    if (!page._renderedSeq) page._renderedSeq = {}
    let changed = false
    types.forEach(t => {
      if (this.globalData.renderSeq[t] !== page._renderedSeq[t]) changed = true
    })
    return changed
  },

  // 写入"当前已渲染"的 renderSeq 快照（renderFromStore 后调用）
  markRenderSeq(page, types) {
    if (!page._renderedSeq) page._renderedSeq = {}
    types.forEach(t => {
      page._renderedSeq[t] = this.globalData.renderSeq[t]
    })
  },

  // 合并写响应里的版本/计数字段（ver 可能只含部分字段）
  applyVersions(ver) {
    if (!ver) return
    const g = this.globalData
    ;['dishVer', 'categoryVer', 'orderVer', 'userVer'].forEach(k => {
      if (typeof ver[k] === 'number') g.versions[k] = ver[k]
    })
    ;['dishCount', 'orderCount'].forEach(k => {
      if (typeof ver[k] === 'number') g.counts[k] = ver[k]
    })
    this._persistMeta()
  },

  // 应用完整 meta（版本校验/bootstrap 返回）
  _applyMeta(meta) {
    if (!meta) return
    const g = this.globalData
    g.versions = {
      dishVer: typeof meta.dishVer === 'number' ? meta.dishVer : g.versions.dishVer,
      categoryVer: typeof meta.categoryVer === 'number' ? meta.categoryVer : g.versions.categoryVer,
      orderVer: typeof meta.orderVer === 'number' ? meta.orderVer : g.versions.orderVer,
      userVer: typeof meta.userVer === 'number' ? meta.userVer : g.versions.userVer,
    }
    g.counts = {
      dishCount: typeof meta.dishCount === 'number' ? meta.dishCount : g.counts.dishCount,
      orderCount: typeof meta.orderCount === 'number' ? meta.orderCount : g.counts.orderCount,
    }
    this._persistMeta()
  },

  // 用户信息写回（改昵称/头像/厨房名后）
  applyUserUpdated(user, partner, userVer) {
    if (user) this.globalData.currentUser = user
    if (partner !== undefined) this.globalData.partner = partner
    if (typeof userVer === 'number') this.applyVersions({ userVer })
    this._bumpSeq('user')
  },

  // 分类写回
  applyCategoryAdded(doc, categoryVer) {
    if (doc) {
      this.globalData.categories = [...this.globalData.categories, doc]
      this._persistCategories()
    }
    this.applyVersions({ categoryVer })
    this._bumpSeq('category')
  },

  applyCategoryUpdated(doc, categoryVer) {
    if (doc && doc._id) {
      this.globalData.categories = this.globalData.categories.map(c =>
        c._id === doc._id ? Object.assign({}, c, doc) : c
      )
      this._persistCategories()
    }
    this.applyVersions({ categoryVer })
    this._bumpSeq('category')
  },

  applyCategoryRemoved(id, categoryVer) {
    this.globalData.categories = this.globalData.categories.filter(c => c._id !== id)
    this._persistCategories()
    this.applyVersions({ categoryVer })
    this._bumpSeq('category')
  },

  // 整体替换分类列表（排序保存后）
  applyCategoryMutation(categories, categoryVer) {
    if (Array.isArray(categories)) {
      this.globalData.categories = categories
      this._persistCategories()
    }
    this.applyVersions({ categoryVer })
    this._bumpSeq('category')
  },

  // 菜品写回
  applyDishAdded(doc, ver) {
    const store = this.globalData.dishStore
    if (doc && store.loaded) {
      // 列表按 createTime 倒序，新菜在最前
      store.dishes = [doc, ...store.dishes.filter(d => d._id !== doc._id)]
      this._persistDishes()
    }
    this.applyVersions(ver)
    this._bumpSeq('dish')
  },

  applyDishUpdated(doc, ver) {
    const store = this.globalData.dishStore
    if (doc && doc._id && store.loaded) {
      store.dishes = store.dishes.map(d => d._id === doc._id ? Object.assign({}, d, doc) : d)
      this._persistDishes()
    }
    this.applyVersions(ver)
    this._bumpSeq('dish')
  },

  applyDishRemoved(id, ver) {
    const store = this.globalData.dishStore
    if (store.loaded) {
      store.dishes = store.dishes.filter(d => d._id !== id)
      this._persistDishes()
    }
    this.applyVersions(ver)
    this._bumpSeq('dish')
  },

  // 订单写回
  applyOrderAdded(doc, ver) {
    if (doc) {
      const home = this.globalData.homeStore
      if (home.loaded) {
        home.orders = [doc, ...home.orders.filter(o => o._id !== doc._id)]
      }
      const his = this.globalData.historyStore
      if (his.loaded) {
        his.orders = [doc, ...his.orders.filter(o => o._id !== doc._id)]
        this._persistHistory()
      }
    }
    this.applyVersions(ver)
    this._bumpSeq('order')
  },

  // 订单字段更新（接单/完成/标记/成品照等）
  applyOrderUpdated(id, changes, ver) {
    if (id && changes) {
      const home = this.globalData.homeStore
      if (home.loaded) {
        home.orders = home.orders.map(o => o._id === id ? Object.assign({}, o, changes) : o)
      }
      const his = this.globalData.historyStore
      if (his.loaded) {
        his.orders = his.orders.map(o => o._id === id ? Object.assign({}, o, changes) : o)
        this._persistHistory()
      }
    }
    this.applyVersions(ver)
    this._bumpSeq('order')
  },

  applyOrderRemoved(id, ver) {
    const home = this.globalData.homeStore
    if (home.loaded) {
      home.orders = home.orders.filter(o => o._id !== id)
    }
    const his = this.globalData.historyStore
    if (his.loaded) {
      his.orders = his.orders.filter(o => o._id !== id)
      this._persistHistory()
    }
    this.applyVersions(ver)
    this._bumpSeq('order')
  },

  // 下单/删单后乐观更新本地菜品 orderCount（不触发 dishVer 变化，避免整库重拉）
  bumpDishOrderCount(ids, delta) {
    const store = this.globalData.dishStore
    if (!store.loaded || !Array.isArray(ids) || !ids.length) return
    const deltaMap = {}
    ids.forEach(id => { deltaMap[id] = (deltaMap[id] || 0) + delta })
    store.dishes = store.dishes.map(d => deltaMap[d._id]
      ? Object.assign({}, d, { orderCount: Math.max(0, (d.orderCount || 0) + deltaMap[d._id]) })
      : d
    )
    this._persistDishes()
  },

  // 菜品排序保存后本地同步（写 sort 字段 + 版本 + 序号 + 持久化）
  // sortList: 排序后的菜品完整对象数组（含 _id），按顺序写 sort = 0..n-1
  applyDishSorted(sortList, ver) {
    const store = this.globalData.dishStore
    if (store.loaded && Array.isArray(sortList) && sortList.length) {
      const sortMap = {}
      sortList.forEach((d, i) => { if (d._id) sortMap[d._id] = i })
      store.dishes = store.dishes.map(d =>
        sortMap[d._id] !== undefined ? Object.assign({}, d, { sort: sortMap[d._id] }) : d
      )
      this._persistDishes()
    }
    this.applyVersions(ver)
    this._bumpSeq('dish')
  },

  // ========== storage 持久化（v2 key）==========

  _persistMeta() {
    const coupleId = this.globalData.currentUser?.coupleId
    if (!coupleId) return
    try {
      wx.setStorageSync('v2_meta_' + coupleId, Object.assign({}, this.globalData.versions, this.globalData.counts))
    } catch (e) { /* ignore quota error */ }
  },

  _persistCategories() {
    const coupleId = this.globalData.currentUser?.coupleId
    if (!coupleId) return
    try {
      wx.setStorageSync('v2_categories_' + coupleId, this.globalData.categories)
    } catch (e) { /* ignore */ }
  },

  _persistDishes() {
    const coupleId = this.globalData.currentUser?.coupleId
    if (!coupleId) return
    try {
      wx.setStorageSync('v2_dishes_' + coupleId, this.globalData.dishStore.dishes)
    } catch (e) { /* ignore */ }
  },

  _persistHistory() {
    const coupleId = this.globalData.currentUser?.coupleId
    if (!coupleId) return
    try {
      const his = this.globalData.historyStore
      wx.setStorageSync('v2_history_' + coupleId, { orders: his.orders, hasMore: his.hasMore, page: his.page })
    } catch (e) { /* ignore */ }
  },

  // 一次性清理 v1 旧缓存 key（含 dishes_cache_undefined 等脏 key）
  _cleanLegacyKeys() {
    try {
      if (wx.getStorageSync('v2_cleaned')) return
      const info = wx.getStorageInfoSync()
      const prefixes = ['categories_', 'stats_', 'dishes_cache_', 'order_dishes_cache_', 'order_history_cache_']
      ;(info.keys || []).forEach(key => {
        if (prefixes.some(p => key.indexOf(p) === 0)) {
          try { wx.removeStorageSync(key) } catch (e) { /* ignore */ }
        }
      })
      wx.setStorageSync('v2_cleaned', 1)
    } catch (e) { /* ignore */ }
  },

  // 解绑后清理全部情侣维度数据
  clearCoupleData() {
    const coupleId = this.globalData.currentUser?.coupleId
    if (coupleId) {
      ['v2_meta_', 'v2_dishes_', 'v2_categories_', 'v2_history_'].forEach(p => {
        try { wx.removeStorageSync(p + coupleId) } catch (e) { /* ignore */ }
      })
    }
    this._cacheCoupleId = null
    this._checkedOnce = false
    const g = this.globalData
    g.versions = { dishVer: -1, categoryVer: -1, orderVer: -1, userVer: -1 }
    g.counts = { dishCount: 0, orderCount: 0 }
    g.categories = []
    g.categoriesLoaded = false
    g.dishStore = { dishes: [], loaded: false }
    g.homeStore = { orders: [], loaded: false }
    g.historyStore = { orders: [], hasMore: true, page: 0, loaded: false }
  },

  // ========== 绑定相关 ==========

  // 绑定伴侣
  async bindPartner(inviteCode) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'bindPartner',
        data: { inviteCode }
      })
      if (res.result && res.result.success) {
        // 绑定成功后走 bootstrap 全量初始化（分类/订单/版本一次到位）
        await this.bootstrap(true)
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
        // 先清情侣维度数据（clearCoupleData 需要用到旧 coupleId）
        this.clearCoupleData()
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
      return { success: false, message: '解绑失败' }
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
        // 响应携带新 userVer，本地同步版本号（对方下次 onShow 校验会感知）
        if (typeof res.result.userVer === 'number') {
          this.applyVersions({ userVer: res.result.userVer })
        }
        this._bumpSeq('user')
        return { success: true }
      }
      return { success: false, message: res.result?.message || '更新失败' }
    } catch (e) {
      console.error('update kitchen name error', e)
      return { success: false, message: '更新失败' }
    }
  },
})
