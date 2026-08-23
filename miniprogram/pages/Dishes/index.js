const app = getApp()
const imageCache = require('../../utils/imageCache.js')

Page({
  data: {
    isBound: false,
    dishes: [],
    allDishes: [],
    categories: [],
    dishesByCategory: {},
    categoryCount: {},
    currentCategory: '__all__',
    loading: true,
    hasLoaded: false,
    partnerName: '',
    searchKey: '',
    // 列数档位：3→4→6 循环，默认 3
    gridCols: 3,
    // 排序模式
    sortMode: false,           // 是否处于排序模式
    sortList: [],              // 排序快照（排序模式下的菜品数组）
    sortSaving: false,         // 保存中
    canSort: false,            // 当前分类是否允许排序（非全部、非搜索、菜品数>1）
    // 拖拽相关
    dragIndex: -1,            // 正在拖拽的卡片索引，-1 表示未拖拽
    dragPos: { x: 0, y: 0 },  // 被拖卡片 fixed 定位（屏幕坐标 px）
    dragSize: { w: 0, h: 0 }, // 被拖卡片尺寸（px）
    refreshing: false,        // 下拉刷新中
    scrollTop: 0,             // scroll-view 滚动位置
  },

  onLoad() {
    // 读取本地持久化的列数偏好
    const saved = wx.getStorageSync('dishes_grid_cols')
    const valid = [3, 4, 6].includes(saved)
    if (valid) {
      this.setData({ gridCols: saved })
    }
  },

  async onShow() {
    app.setKitchenTitle()
    this.getPartnerName()
    const isFirst = !this.data.hasLoaded
    // 版本校验：每次 onShow 直连读 CoupleMeta，对方有修改则精准重拉对应数据
    const r = await app.syncOnShow('dishes')
    if (isFirst) {
      this.setData({ hasLoaded: true })
      this.renderFromStore({ resetState: true })
    } else {
      // 用渲染序号判断本端/对方数据是否变化（版本号机制只感知对方写入、感知不到本端写入，
      // 故删菜/加菜后需靠 renderSeq 触发重渲染，避免返回页面仍显示旧数据）
      const needRender = app.checkRenderSeq(this, ['dish', 'category', 'user'])
      if (needRender) {
        // 数据有变化才重渲染（保留搜索/分类状态）；无变化时不动页面，零闪屏
        this.renderFromStore({ resetState: false })
      } else {
        this.setData({ loading: false })
      }
    }
    // 记录当前渲染快照，供下次 onShow 比对
    app.markRenderSeq(this, ['dish', 'category', 'user'])
  },

  // 从共享 dishStore 渲染（唯一数据源）
  renderFromStore(options = {}) {
    const { resetState = false } = options
    const savedKey = resetState ? '' : this.data.searchKey
    const savedCat = resetState ? '__all__' : this.data.currentCategory

    const dishes = this._mapDishes(app.globalData.dishStore.dishes)
    const categories = this._resolveCategories(dishes)
    const filtered = savedKey
      ? dishes.filter(d => d.name.includes(savedKey) || (d.description && d.description.includes(savedKey)))
      : dishes
    const { dishesByCategory } = this._syncCategoryData(filtered, categories)
    const { categories: catsWithAll, dishesByCategory: dbcWithAll, categoryCount } =
      this._prependAllCategory(filtered, categories, dishesByCategory)

    this.setData({
      dishes: filtered,
      allDishes: dishes,
      categories: catsWithAll,
      dishesByCategory: dbcWithAll,
      categoryCount,
      currentCategory: savedCat || '__all__',
      searchKey: savedKey,
      loading: false
    })
    this._updateCanSort()
    if (resetState) {
      this._scrollToListTop()
    }
  },

  // 计算当前分类是否允许排序：非全部、非搜索、菜品数>1
  _updateCanSort() {
    const cat = this.data.currentCategory
    const list = this.data.dishesByCategory[cat] || []
    const can = cat !== '__all__' && !this.data.searchKey && list.length > 1
    this.setData({ canSort: can })
  },

  // 回顶：通过 scroll-view 的 scroll-top 绑定瞬时回顶
  _scrollToListTop() {
    this.setData({ scrollTop: 0 })
  },

  // 获取伴侣名字
  async getPartnerName() {
    await app.loadUserInfo()
    const partnerName = app.getPartnerName()
    this.setData({ partnerName })
  },

  // 原生页面下拉刷新（3s 防抖）- 强制版本校验 + 重拉变化数据
  // 关键：原生手势只在页面 scrollTop=0 继续下拉时触发，
  // 列表中间位置上滑回顶绝不会误触发 —— 这是本次修复 bug 的核心
  // scroll-view 下拉刷新（排序模式 refresher 已禁用，不会触发）
  async onRefresh() {
    const now = Date.now()
    if (now - app.globalData.lastPullTs < 3000) {
      this.setData({ refreshing: false })
      return
    }
    app.globalData.lastPullTs = now
    try {
      await app.syncOnShow('dishes', { force: true })
      this.renderFromStore({ resetState: true })
    } catch (e) {
      console.error('dishes onRefresh error', e)
    } finally {
      this.setData({ refreshing: false })
    }
  },

  // 将原始菜品数据映射为页面展示结构
  _mapDishes(data) {
    return (data || []).map(item => ({
      ...item,
      createTimeText: this.formatDate(item.createTime),
      category: item.category || 'meat',
      // 本地持久缓存优先，未命中走 cloud:// 并后台落盘
      _localImg: imageCache.resolve(item.imageUrl) || item.imageUrl || ''
    }))
  },

  // 兜底：分类为空时用菜品自带的 category 生成临时分组
  _resolveCategories(dishes) {
    let categories = app.globalData.categories || []
    if (categories.length === 0) {
      const catMap = {}
      dishes.forEach(d => {
        const cid = d.category || 'other'
        if (!catMap[cid]) catMap[cid] = { _id: cid, name: cid, icon: '🍽️' }
      })
      categories = Object.values(catMap)
    }
    return categories
  },

  // 重新按分类整理菜品数据
  _syncCategoryData(dishes, categories) {
    const cats = categories || this.data.categories || []
    const dishesByCategory = {}
    cats.forEach(cat => {
      if (cat._id === '__all__') {
        // 全部分类保持现状（createTime 倒序，由 reloadDishes orderBy 保证）
        dishesByCategory[cat._id] = dishes
      } else {
        // 具体分类按 sort 升序，无 sort 的旧菜品排末尾（按 createTime 倒序）
        const catDishes = dishes.filter(d => d.category === cat._id).slice()
        catDishes.sort((a, b) => {
          const aHas = typeof a.sort === 'number'
          const bHas = typeof b.sort === 'number'
          if (aHas && bHas) return a.sort - b.sort
          if (aHas) return -1
          if (bHas) return 1
          const aTime = a.createTime ? new Date(a.createTime).getTime() : 0
          const bTime = b.createTime ? new Date(b.createTime).getTime() : 0
          return bTime - aTime
        })
        dishesByCategory[cat._id] = catDishes
      }
    })
    return { dishesByCategory }
  },
  // 在分类列表首位插入“全部”并更新对应数据
  _prependAllCategory(dishes, categories, existingDishesByCategory) {
    const allCat = { _id: '__all__', name: '全部', icon: '🍽️' }
    const cats = [allCat, ...categories]
    const dishesByCategory = existingDishesByCategory || {}
    dishesByCategory['__all__'] = dishes
    const categoryCount = {}
    cats.forEach(cat => {
      categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
    })
    return { categories: cats, dishesByCategory, categoryCount }
  },

  // 选择分类 - 切换显示当前分类菜品
  selectCategory(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ currentCategory: id })
    this._scrollToListTop()
    this._updateCanSort()
  },

  // 搜索输入
  onSearchInput(e) {
    const searchKey = e.detail.value.trim()
    this.setData({ searchKey })
    this.filterDishes(searchKey)
  },

  // 清除搜索
  clearSearch() {
    this.setData({ searchKey: '' })
    this.filterDishes('')
  },

  // 切换列数档位 2→3→4→6→2
  toggleGridCols() {
    const order = [3, 4, 6]
    const cur = this.data.gridCols
    const idx = order.indexOf(cur)
    const next = order[(idx + 1) % order.length]
    this.setData({ gridCols: next })
    wx.setStorageSync('dishes_grid_cols', next)
  },

  // 过滤菜品
  filterDishes(searchKey) {
    const { allDishes } = this.data
    const dishes = searchKey
      ? allDishes.filter(d =>
          d.name.includes(searchKey) ||
          (d.description && d.description.includes(searchKey))
        )
      : allDishes
    const realCategories = this.data.categories.filter(c => c._id !== '__all__')
    const { dishesByCategory } = this._syncCategoryData(dishes, realCategories)
    const { categories: catsWithAll, dishesByCategory: dbcWithAll, categoryCount } =
      this._prependAllCategory(dishes, realCategories, dishesByCategory)

    this.setData({
      dishes,
      dishesByCategory: dbcWithAll,
      categoryCount,
      categories: catsWithAll,
      currentCategory: '__all__'
    })
    this._scrollToListTop()
    this._updateCanSort()
  },

  // 跳转到添加页
  toAddPage() {
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/dish-add/index' })
  },

  // 跳转到详情页
  toDetailPage(e) {
    // 排序模式下卡片 tap 不跳详情
    if (this.data.sortMode) return
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(item => item._id === id)
    const imageUrl = dish?.imageUrl ? encodeURIComponent(dish.imageUrl) : ''
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${id}&imageUrl=${imageUrl}` })
  },

  // ========== 排序模式 ==========

  // 进入排序模式：快照当前分类列表（布局完全复用浏览 flex，无需测量）
  enterSort() {
    if (!this.data.canSort) return
    const cat = this.data.currentCategory
    const list = (this.data.dishesByCategory[cat] || []).slice()
    if (list.length < 2) return
    this.setData({
      sortMode: true,
      sortList: list,
      dragIndex: -1,
      dragPos: { x: 0, y: 0 },
      dragSize: { w: 0, h: 0 },
    })
  },

  // 取消排序：丢弃 sortList 退出
  exitSortNoSave() {
    this.setData({
      sortMode: false,
      sortList: [],
      dragIndex: -1,
      dragPos: { x: 0, y: 0 },
      dragSize: { w: 0, h: 0 },
      sortSaving: false,
    })
  },

  // 完成排序：保存到云端
  async saveSort() {
    if (this.data.sortSaving) return
    this.setData({ sortSaving: true })
    wx.showLoading({ title: '保存中...', mask: true })
    try {
      const sortList = this.data.sortList
      const updates = sortList.map((d, i) => ({ docId: d._id, data: { sort: i } }))
      const res = await wx.cloud.callFunction({
        name: 'updateCoupleData',
        data: {
          collection: 'DishList',
          action: 'batchUpdate',
          updates,
        },
      })
      wx.hideLoading()
      if (res.result && res.result.success) {
        app.applyDishSorted(sortList, res.result.ver)
        // 刷新页面展示（按新 sort 排序）
        this.renderFromStore({ resetState: false })
        this.setData({ sortMode: false, sortList: [], dragIndex: -1, sortSaving: false })
        wx.showToast({ title: '排序已保存', icon: 'success' })
      } else {
        this.setData({ sortSaving: false })
        wx.showToast({ title: res.result?.message || '保存失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      this.setData({ sortSaving: false })
      console.error('save sort error', e)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  },

  // 卡片点击：仅浏览模式跳详情
  onCardTap(e) {
    if (this.data.sortMode) return
    this.toDetailPage(e)
  },

  // 长按卡片激活拖拽：立即进入拖动状态
  onSortLongPress(e) {
    if (!this.data.sortMode) return
    const index = e.currentTarget.dataset.index
    const touch = e.touches && e.touches[0]
    if (!touch) return
    this._touchStart = { x: touch.clientX, y: touch.clientY }
    this._lastMoveTs = 0
    // 震动反馈，明确告知进入拖拽
    wx.vibrateShort && wx.vibrateShort({ type: 'light' })
    // 测被拖卡片初始位置（屏幕坐标），作为 fixed 跟手基准
    const q = wx.createSelectorQuery().in(this)
    q.selectAll('.sort-card').boundingClientRect(rects => {
      if (!rects || !rects.length) return
      const rect = rects[index]
      if (!rect) return
      this._dragRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      // 缓存所有卡片中心（用于换位判定）
      this._cardCenters = rects.map(r => ({
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      }))
      this.setData({
        dragIndex: index,
        dragPos: { x: rect.left, y: rect.top },
        dragSize: { w: rect.width, h: rect.height },
      })
    }).exec()
  },

  // 拖拽移动：fixed 跟手 + 找最近卡片换位
  onSortTouchMove(e) {
    if (this.data.dragIndex < 0 || !this._dragRect) return
    const touch = e.touches && e.touches[0]
    if (!touch) return
    // 节流 ~16ms，减少 setData 频率保证流畅
    const now = Date.now()
    if (this._lastMoveTs && now - this._lastMoveTs < 16) return
    this._lastMoveTs = now

    // 被拖卡片 fixed 跟随手指
    const dx = touch.clientX - this._touchStart.x
    const dy = touch.clientY - this._touchStart.y
    this.setData({
      dragPos: {
        x: this._dragRect.left + dx,
        y: this._dragRect.top + dy,
      },
    })

    // 找手指最近的“其他卡片”中心 → 目标索引
    const centers = this._cardCenters
    if (!centers || !centers.length) return
    const dragIdx = this.data.dragIndex
    let targetIndex = dragIdx
    let minDist = Infinity
    centers.forEach((c, i) => {
      if (i === dragIdx) return
      const dist = Math.abs(c.cx - touch.clientX) + Math.abs(c.cy - touch.clientY)
      if (dist < minDist) { minDist = dist; targetIndex = i }
    })
    if (targetIndex === dragIdx) return

    // 交换数组顺序：被拖卡在数组里也移动，flex 坑位正确，其余卡片平滑滑动
    const list = this.data.sortList.slice()
    const [moved] = list.splice(dragIdx, 1)
    list.splice(targetIndex, 0, moved)
    this.setData({ sortList: list, dragIndex: targetIndex })
    // 重排后下一帧重测中心（被拖卡 fixed 不变，其余卡片位置变了）
    wx.nextTick(() => {
      const q = wx.createSelectorQuery().in(this)
      q.selectAll('.sort-card').boundingClientRect(rects => {
        if (!rects) return
        this._cardCenters = rects.map(r => ({
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
        }))
      }).exec()
    })
  },

  // 拖拽结束落位
  onSortTouchEnd() {
    if (this.data.dragIndex < 0) return
    this.setData({ dragIndex: -1, dragPos: { x: 0, y: 0 }, dragSize: { w: 0, h: 0 } })
    this._dragRect = null
    this._touchStart = null
    this._cardCenters = null
    this._lastMoveTs = 0
  },

  // 格式化日期
  formatDate(date) {
    if (!date) return ''
    const d = new Date(date)
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    return `${month}-${day}`
  },

  // 分享菜品库
  onShareAppMessage() {
    return {
      title: '来看看我们的小厨房菜单吧',
      path: '/pages/dishes/index',
      imageUrl: '/images/default.jpg'
    }
  },
})
