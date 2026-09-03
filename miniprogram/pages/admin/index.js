const app = getApp()
const imageCache = require('../../utils/imageCache.js')

const PAGE_SIZE = 20
const COUPLE_PAGE_SIZE = 6   // 情侣选择面板每页 6 张卡（2 列 × 3 行）
const DEFAULT_IMG = '/images/default.jpg'
// 与 order-detail 一致的星级文案
const RATING_LABELS = ['', '有点翻车 🙈', '心意满分 💕', '味道在线 😊', '超好吃！😋', '幸福的味道！🥰']

// 页码窗口：≤7 页全显；更多页显示「首页 + 当前页附近 + 末页」，避免页码条过长
function buildPageNumbers(current, pageCount) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }
  const set = new Set([1, current - 1, current, current + 1, pageCount])
  return [...set].filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b)
}

Page({
  data: {
    loading: true,
    loadError: '',          // 加载失败的真实错误信息（直接展示，便于定位部署问题）
    denied: false,          // 非管理员兜底（云端白名单也会拒绝，双保险）
    // ---- 情侣浏览（排序 + 筛选 + 网格分页）----
    currentCouple: null,    // 当前选中的情侣对象
    activeCoupleId: '',
    activePos: 0,           // 第几对（全量排序中的位次，1 起）
    totalCouples: 0,        // 共几对
    pickerOpen: false,      // 选择面板展开态
    sortBy: 'orderCount',   // dishCount 菜多优先 | orderCount 单多优先
    coupleSearch: '',       // 昵称筛选关键字
    couplePage: 0,
    couplePageCount: 1,
    pageNumbers: [1],
    pagedCouples: [],       // 当前页卡片（含 pos 位次、active 选中态）
    unboundCount: 0,
    tab: 'orders',          // orders | dishes（默认订单）
    // ---- 菜品区（菜品库视图：分类 + 排序 + 列数）----
    dishes: [],             // 当前情侣全部菜品（原始平铺，空态判断用）
    dishesLoaded: false,
    categories: [],         // 含「全部」的分类数组
    dishesByCategory: {},   // 各分类已排序菜品
    categoryCount: {},      // 各分类菜品数
    currentCategory: '__all__',
    catSortMap: {},         // 各分类排序方式记忆 { [catId]: {type, desc} }
    curSortLabel: '最热',
    orders: [],
    ordersHasMore: false,
    ordersLoading: false,
  },

  onLoad() {
    this._cache = {}        // coupleId -> { dishRaw, categories, orders, ordersHasMore }
    this._memberMap = {}    // openid -> nickname（评价/回复署名用）
    // 恢复排序偏好（与菜品库独立的 storage key）
    const savedSort = wx.getStorageSync('admin_cat_sort')
    this.setData({
      catSortMap: (savedSort && typeof savedSort === 'object') ? savedSort : {}
    })
    this.init()
  },

  async init() {
    await app.loadUserInfo()
    if (!app.isAdmin()) {
      this.setData({ loading: false, denied: true })
      return
    }
    await this.loadCouples()
  },

  async callAdmin(data) {
    const res = await wx.cloud.callFunction({ name: 'adminQuery', data })
    const r = res.result
    if (!r || !r.success) {
      throw new Error((r && r.message) || '查询失败')
    }
    return r
  },

  // ========== 情侣列表 ==========
  async loadCouples() {
    this.setData({ loading: true })
    try {
      const r = await this.callAdmin({ action: 'couples' })
      const couples = (r.couples || []).map(c => {
        // 登记 openid -> 昵称
        for (const m of c.members) this._memberMap[m.openid] = m.nickname
        return {
          coupleId: c.coupleId,
          names: c.members.map(m => m.nickname).join(' & '),
          avatars: c.members.map(m => m.avatarUrl || ''),
          dishCount: c.dishCount || 0,
          orderCount: c.orderCount || 0
        }
      })
      for (const m of (r.unbound || [])) this._memberMap[m.openid] = m.nickname

      // 排除 0 道菜的情侣
      const visible = couples.filter(c => c.dishCount > 0)
      this._allCouples = visible

      this.setData({
        loading: false,
        loadError: '',
        unboundCount: (r.unbound || []).length,
        activeCoupleId: visible.length ? visible[0].coupleId : ''
      }, () => {
        this.recomputeCoupleView()
        if (visible.length) this.loadCurrentTab()
      })
    } catch (e) {
      console.error('loadCouples error', e)
      this.setData({ loading: false, loadError: e.message || '加载失败' })
    }
  },

  // 排序 + 筛选 + 分页的派生视图（唯一出口，任何条件变化都走这里重算）
  recomputeCoupleView() {
    const { sortBy, coupleSearch, activeCoupleId } = this.data
    const all = this._allCouples || []
    const sorted = all.slice().sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
    this._sortedCouples = sorted   // 滑动切换定位用

    const activeIdx = sorted.findIndex(c => c.coupleId === activeCoupleId)
    const currentCouple = activeIdx >= 0 ? sorted[activeIdx] : null

    const kw = coupleSearch.trim().toLowerCase()
    const filtered = kw ? sorted.filter(c => c.names.toLowerCase().includes(kw)) : sorted
    const pageCount = Math.max(1, Math.ceil(filtered.length / COUPLE_PAGE_SIZE))
    let page = Math.min(Math.max(0, this.data.couplePage), pageCount - 1)

    const pagedCouples = filtered
      .slice(page * COUPLE_PAGE_SIZE, (page + 1) * COUPLE_PAGE_SIZE)
      .map(c => ({
        coupleId: c.coupleId,
        names: c.names,
        avatars: c.avatars,
        dishCount: c.dishCount,
        orderCount: c.orderCount,
        pos: sorted.indexOf(c) + 1,
        active: c.coupleId === activeCoupleId
      }))

    this.setData({
      currentCouple,
      activePos: activeIdx >= 0 ? activeIdx + 1 : 0,
      totalCouples: sorted.length,
      pagedCouples,
      couplePage: page,
      couplePageCount: pageCount,
      pageNumbers: buildPageNumbers(page + 1, pageCount)
    })
  },

  // ========== 情侣浏览交互 ==========
  togglePicker() {
    this.setData({ pickerOpen: !this.data.pickerOpen })
  },

  selectCouple(e) {
    const coupleId = e.currentTarget.dataset.id
    if (!coupleId) return
    if (coupleId === this.data.activeCoupleId) {
      this.setData({ pickerOpen: false })
      return
    }
    this.setData({ activeCoupleId: coupleId, pickerOpen: false }, () => {
      this.recomputeCoupleView()
      this.loadCurrentTab()
    })
  },

  setSort(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.sortBy) return
    this.setData({ sortBy: key, couplePage: 0 }, () => this.recomputeCoupleView())
  },

  onCoupleSearch(e) {
    this.setData({ coupleSearch: e.detail.value, couplePage: 0 }, () => this.recomputeCoupleView())
  },

  prevCouplePage() {
    if (this.data.couplePage <= 0) return
    this.setData({ couplePage: this.data.couplePage - 1 }, () => this.recomputeCoupleView())
  },

  nextCouplePage() {
    if (this.data.couplePage >= this.data.couplePageCount - 1) return
    this.setData({ couplePage: this.data.couplePage + 1 }, () => this.recomputeCoupleView())
  },

  gotoCouplePage(e) {
    const page = Number(e.currentTarget.dataset.page)
    if (page === this.data.couplePage) return
    this.setData({ couplePage: page }, () => this.recomputeCoupleView())
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab }, () => this.loadCurrentTab())
  },

  // ========== 左右滑动切换情侣 ==========
  onTouchStart(e) {
    const t = e.touches[0]
    this._touchStart = { x: t.clientX, y: t.clientY }
  },

  onTouchEnd(e) {
    if (!this._touchStart) return
    const start = this._touchStart
    this._touchStart = null
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    // 水平位移足够且明显大于纵向位移才算滑动切换（不拦截垂直滚动与点击）
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    this.swipeCouple(dx < 0 ? 1 : -1)
  },

  // 左滑=下一对，右滑=上一对（按当前排序位次，循环）
  swipeCouple(step) {
    const sorted = this._sortedCouples || []
    if (sorted.length < 2) return
    const idx = sorted.findIndex(c => c.coupleId === this.data.activeCoupleId)
    if (idx < 0) return
    const next = (idx + step + sorted.length) % sorted.length
    this.setData({ activeCoupleId: sorted[next].coupleId, pickerOpen: false }, () => {
      this.recomputeCoupleView()
      this.loadCurrentTab()
    })
  },

  currentCoupleId() {
    return this.data.activeCoupleId
  },

  // 按当前 tab 加载（命中缓存秒开）
  loadCurrentTab() {
    const coupleId = this.currentCoupleId()
    if (!coupleId) return
    const cached = this._cache[coupleId]

    if (this.data.tab === 'dishes') {
      if (cached && cached.dishRaw) {
        const view = this._buildDishView(cached.dishRaw, cached.categories)
        this.setData(Object.assign({
          dishes: cached.dishRaw,
          dishesLoaded: true,
          currentCategory: '__all__'
        }, view), () => this._refreshSortLabel())
      } else {
        this.loadDishes(coupleId)
      }
    } else {
      if (cached && cached.orders) {
        this.setData({ orders: cached.orders, ordersHasMore: cached.ordersHasMore })
      } else {
        this.loadOrders(coupleId, false)
      }
    }
  },

  // ========== 菜品（菜品库视图） ==========
  async loadDishes(coupleId) {
    this.setData({ dishesLoaded: false })
    try {
      const r = await this.callAdmin({ action: 'dishes', coupleId })
      const dishRaw = (r.dishes || []).map(d => this.processDish(d))
      // 「全部」在最前；菜品里有但分类表缺失的旧分类 id 兜底成临时分类
      const categories = this._resolveCategories(r.categories || [], dishRaw)
      this._cache[coupleId] = Object.assign(this._cache[coupleId] || {}, { dishRaw, categories })
      // 防止加载期间用户已切换情侣
      if (this.currentCoupleId() === coupleId) {
        const view = this._buildDishView(dishRaw, categories)
        this.setData(Object.assign({
          dishes: dishRaw,
          dishesLoaded: true,
          currentCategory: '__all__'
        }, view), () => this._refreshSortLabel())
      }
    } catch (e) {
      console.error('loadDishes error', e)
      this.setData({ dishesLoaded: true })
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    }
  },

  // 分类数组兜底：全部 + 云端分类 + 菜品引用但缺失的旧分类（legacyId 映射中文名）
  _resolveCategories(cloudCats, dishes) {
    const LEGACY = {
      meat: { name: '荤菜', icon: '🥩' }, vegetable: { name: '素菜', icon: '🥬' },
      soup: { name: '汤类', icon: '🍲' }, rice: { name: '主食', icon: '🍚' },
      noodle: { name: '面食', icon: '🍜' }, cold: { name: '凉菜', icon: '🥗' },
      dessert: { name: '甜点', icon: '🍰' }, drink: { name: '饮品', icon: '🥤' }
    }
    const cats = [{ _id: '__all__', name: '全部', icon: '🍽️' }].concat(cloudCats)
    const known = {}
    for (const c of cats) known[c._id] = true
    for (const d of dishes) {
      const cid = d.category || ''
      if (cid && !known[cid]) {
        known[cid] = true
        const legacy = LEGACY[cid]
        cats.push({ _id: cid, name: legacy ? legacy.name : cid, icon: legacy ? legacy.icon : '🍽️' })
      }
    }
    return cats
  },

  // 构建分类分组 + 各分类按记忆排序（与菜品库同规则）
  _buildDishView(dishes, categories) {
    const dishesByCategory = {}
    const categoryCount = {}
    for (const cat of categories) {
      const list = cat._id === '__all__'
        ? dishes.slice()
        : dishes.filter(d => d.category === cat._id)
      dishesByCategory[cat._id] = this._sortListFor(cat._id, list, categories)
      categoryCount[cat._id] = list.length
    }
    return { categories, dishesByCategory, categoryCount }
  },

  // 当前分类的排序方式：无记录时默认「最热」（被点次数降序）
  _sortState(catId) {
    const s = (this.data.catSortMap || {})[catId]
    if (s && ['time', 'orderCount', 'category'].includes(s.type)) return s
    return { type: 'orderCount', desc: true }
  },

  _refreshSortLabel() {
    const { type } = this._sortState(this.data.currentCategory)
    this.setData({ curSortLabel: type === 'time' ? '最新' : type === 'orderCount' ? '最热' : '菜单' })
  },

  _timeOf(d) {
    return d.createTime ? new Date(d.createTime).getTime() : 0
  },

  // 分类内排序比较：sort 升序，无 sort 的旧菜品排末尾（按 createTime 倒序）
  _cmpInCategory(a, b) {
    const aHas = typeof a.sort === 'number'
    const bHas = typeof b.sort === 'number'
    if (aHas && bHas) return a.sort - b.sort
    if (aHas) return -1
    if (bHas) return 1
    return this._timeOf(b) - this._timeOf(a)
  },

  // 指定分类的列表排序：time=按时间、orderCount=按点菜次数、category=菜单顺序
  // 「全部」的菜单顺序=按分类现有顺序分组拼接；具体分类的菜单顺序=手动 sort 升序
  _sortListFor(catId, dishes, categories) {
    const list = (dishes || []).slice()
    const { type, desc } = this._sortState(catId)
    if (type === 'orderCount') {
      list.sort((a, b) => {
        const diff = (b.orderCount || 0) - (a.orderCount || 0)
        if (diff) return desc ? diff : -diff
        return this._timeOf(b) - this._timeOf(a)
      })
      return list
    }
    if (type === 'time') {
      list.sort((a, b) => desc ? this._timeOf(b) - this._timeOf(a) : this._timeOf(a) - this._timeOf(b))
      return list
    }
    if (catId !== '__all__') {
      list.sort((a, b) => this._cmpInCategory(a, b))
      return list
    }
    const cats = (categories || []).filter(c => c._id !== '__all__')
    const order = {}
    cats.forEach((c, i) => { order[c._id] = i })
    const groups = {}
    list.forEach(d => {
      const cid = d.category || 'other'
      ;(groups[cid] = groups[cid] || []).push(d)
    })
    const cids = Object.keys(groups).sort((a, b) => {
      const ai = order[a] === undefined ? cats.length : order[a]
      const bi = order[b] === undefined ? cats.length : order[b]
      return ai - bi
    })
    const result = []
    cids.forEach(cid => {
      result.push(...groups[cid].sort((x, y) => this._cmpInCategory(x, y)))
    })
    return result
  },

  // 选择分类
  selectCategory(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ currentCategory: id }, () => this._refreshSortLabel())
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  // 排序方式选择：作用于当前分类，各分类独立记忆；重复点选（时间/次数）翻转正倒序，菜单无方向
  openAllSortSheet() {
    const cat = this.data.currentCategory
    const { type: curType, desc: curDesc } = this._sortState(cat)
    const item = (type, label) => {
      const cur = curType === type
      const arrow = type === 'category' ? '' : ` ${cur ? (curDesc ? '↓' : '↑') : '↓'}`
      return `${cur ? '✓ ' : ''}${label}${arrow}`
    }
    wx.showActionSheet({
      alertText: '再点一次 可反转顺序 (菜单除外)',
      itemList: [
        item('time', '创建时间'),
        item('orderCount', '点菜次数'),
        item('category', '菜单顺序'),
      ],
      success: ({ tapIndex }) => {
        const type = ['time', 'orderCount', 'category'][tapIndex]
        if (!type) return
        let desc = true
        if (type === curType) {
          if (type === 'category') return
          desc = !curDesc
        }
        const catSortMap = Object.assign({}, this.data.catSortMap, { [cat]: { type, desc } })
        this.setData({ catSortMap })
        wx.setStorageSync('admin_cat_sort', catSortMap)
        this._refreshSortLabel()
        // 纯内存重排当前分类
        const dbc = Object.assign({}, this.data.dishesByCategory)
        dbc[cat] = this._sortListFor(cat, dbc[cat] || [], this.data.categories)
        this.setData({ dishesByCategory: dbc })
      },
    })
  },

  // 图集兼容规则：images 缺失时由 imageUrl 合成；占位图不算入图集
  processDish(d) {
    let gallery = Array.isArray(d.images) && d.images.length ? d.images.slice() : []
    if (!gallery.length && d.imageUrl && d.imageUrl !== DEFAULT_IMG) {
      gallery = [d.imageUrl]
    }
    gallery = gallery.filter(id => id && id !== DEFAULT_IMG)
    const view = Object.assign({}, d)
    view.gallery = gallery.map(id => imageCache.resolve(id) || id)
    view.galleryRaw = gallery   // previewImage 用原始 fileID
    view.cover = view.gallery[0] || DEFAULT_IMG
    return view
  },

  // ========== 订单 ==========
  async loadOrders(coupleId, append) {
    // 按 coupleId 防重入：全局 ordersLoading 只做 UI 展示，
    // 否则会吞掉「加载中切换情侣」的新请求
    if (this._ordersLoadingFor === coupleId) return
    this._ordersLoadingFor = coupleId
    const existing = append ? (this._cache[coupleId]?.orders || []) : []
    this.setData({ ordersLoading: true })
    try {
      const r = await this.callAdmin({
        action: 'orders',
        coupleId,
        skip: existing.length,
        limit: PAGE_SIZE
      })
      const batch = (r.orders || []).map(o => this.processOrder(o))
      const orders = existing.concat(batch)
      this._cache[coupleId] = Object.assign(this._cache[coupleId] || {}, {
        orders,
        ordersHasMore: !!r.hasMore
      })
      if (this.currentCoupleId() === coupleId) {
        this.setData({ orders, ordersHasMore: !!r.hasMore, ordersLoading: false })
      } else {
        this.setData({ ordersLoading: false })
      }
    } catch (e) {
      console.error('loadOrders error', e)
      this.setData({ ordersLoading: false })
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    } finally {
      if (this._ordersLoadingFor === coupleId) this._ordersLoadingFor = null
    }
  },

  processOrder(o) {
    const view = Object.assign({}, o)
    view.timeText = this.formatEntryTime(o.createTime)
    view.statusText = o.status === 'completed' ? '已完成' : o.status === 'pending' ? '进行中' : '待接单'
    view.statusClass = o.status === 'completed' ? 'st-completed' : o.status === 'pending' ? 'st-pending' : 'st-waiting'
    // 菜品快照小图
    view.dishViews = (o.dishes || []).map(d => ({
      name: d.name,
      img: d.imageUrl ? (imageCache.resolve(d.imageUrl) || d.imageUrl) : DEFAULT_IMG,
      raw: d.imageUrl || ''
    }))
    // 成品照（兼容单字符串与数组）
    let photos = []
    if (Array.isArray(o.finishedPhoto)) photos = o.finishedPhoto.filter(Boolean)
    else if (o.finishedPhoto) photos = [o.finishedPhoto]
    view.photoRaws = photos
    view.photoViews = photos.map(id => imageCache.resolve(id) || id)
    // 评价与大厨回复
    view.reviewView = o.review ? this.formatReviewEntry(o.review) : null
    view.replyView = o.reviewReply ? this.formatReviewEntry(o.reviewReply) : null
    return view
  },

  formatReviewEntry(entry) {
    const view = Object.assign({}, entry, { timeText: this.formatEntryTime(entry.createTime) })
    if (entry.rating) view.labelText = RATING_LABELS[entry.rating] || ''
    view.authorName = this._memberMap[entry._openid] || 'TA'
    return view
  },

  // 同年 MM/DD HH:MM，跨年补年份（与 order-detail 一致）
  formatEntryTime(date) {
    if (!date) return ''
    const d = new Date(date)
    const now = new Date()
    const p = n => String(n).padStart(2, '0')
    const time = `${p(d.getHours())}:${p(d.getMinutes())}`
    const md = `${p(d.getMonth() + 1)}/${p(d.getDate())}`
    if (d.getFullYear() !== now.getFullYear()) {
      return `${d.getFullYear()}/${md} ${time}`
    }
    return `${md} ${time}`
  },

  // ========== 分页 ==========
  onReachBottom() {
    if (this.data.tab !== 'orders') return
    if (!this.data.ordersHasMore || this.data.ordersLoading) return
    this.loadOrders(this.currentCoupleId(), true)
  },

  // ========== 图片预览 ==========
  previewImage(e) {
    const { urls, current } = e.currentTarget.dataset
    if (!urls || !urls.length) return
    wx.previewImage({ urls, current: current || urls[0] })
  }
})
