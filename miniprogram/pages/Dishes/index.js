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
    sortMode: false,          // 是否处于排序模式
    sortReady: false,         // 测量完成、已切换绝对定位接管
    sortAnim: false,          // 接管完成后开启换位补位过渡动画
    noTrans: false,           // 进出排序的瞬时帧禁用一切过渡（防 transform 插值飞卡）
    sortList: [],             // 排序快照（排序模式下的菜品数组）
    slots: [],                // 槽位坐标系 [{sx,sy,w,h}]，相对 grid 原点 px，一次测量全程不变
    sortGridH: 0,             // grid 显式高度 px（绝对定位接管时撑开容器）
    sortSaving: false,        // 保存中
    canSort: false,           // 当前分类是否允许排序（非全部、非搜索、菜品数>1）
    // 拖拽相关
    dragId: '',               // 被拖菜品 _id，'' 表示未拖拽
    dragItem: null,           // 被拖菜品数据（浮层渲染用）
    dragPos: { x: 0, y: 0 },  // 浮层视口坐标 px
    dragSize: { w: 0, h: 0 }, // 浮层尺寸 px
    dragSettling: false,      // 松手回弹落位动画中
    gridShift: 0,             // 拖拽中虚拟滚动位移 px（grid 容器 translateY）
    refreshing: false,        // 下拉刷新中
    scrollTop: 0,             // scroll-view 滚动位置
  },

  onUnload() {
    this._stopAutoScroll()
    if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null }
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

  // 进入排序：两阶段接管，保证菜品图片位置像素级一致
  // 阶段A：仅切数据源与样式类（grid 仍是原 flex 布局，视觉不变），渲染完成后一次性测量
  // 阶段B：按实测坐标切换绝对定位（translate 到原位置，零位移），下一帧再开启补位过渡
  enterSort(cb) {
    const done = typeof cb === 'function' ? cb : null
    if (!this.data.canSort || this.data.sortMode) { done && done(false); return }
    const cat = this.data.currentCategory
    const list = (this.data.dishesByCategory[cat] || []).slice()
    if (list.length < 2) { done && done(false); return }
    this.setData({
      sortMode: true,
      sortReady: false,
      sortAnim: false,
      noTrans: true,   // 测量期间禁用过渡：避免 :active 缩放回弹污染测量
      sortList: list,
      dragId: '',
      dragItem: null,
      gridShift: 0,
    }, () => {
      this._measureSlots(slots => {
        if (!slots) { done && done(false); return }
        this.setData({
          slots,
          sortGridH: this._gridH,
          sortReady: true,
        }, () => {
          wx.nextTick(() => this.setData({ sortAnim: true, noTrans: false }))
          done && done(true)
        })
      })
    })
  },

  // 一次性测量：构建槽位坐标系（相对 grid 原点，减法天然抵消滚动，全程不再重测）
  _measureSlots(cb) {
    const q = wx.createSelectorQuery().in(this)
    q.selectAll('.dish-card').boundingClientRect()
    q.select('.dish-grid').boundingClientRect()
    q.exec(res => {
      if (!res || !res[0] || !res[0].length || !res[1]) return cb(null)
      const rects = res[0]
      const gridRect = res[1]
      this._gridH = gridRect.height
      cb(rects.map(r => ({
        sx: r.left - gridRect.left,
        sy: r.top - gridRect.top,
        w: r.width,
        h: r.height,
      })))
    })
  },

  // 取消排序：丢弃快照退出
  exitSortNoSave() {
    this._exitSort({ sortSaving: false })
  },

  // 退出排序回浏览态：先带 noTrans 摘除绝对定位（防 transform 过渡飞卡），下一帧恢复
  _exitSort(extra = {}) {
    if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null }
    this._stopAutoScroll()
    this._gridShift = 0
    this._grabOffset = null
    this._finger = null
    this.setData({
      sortMode: false,
      sortReady: false,
      sortAnim: false,
      noTrans: true,
      sortList: [],
      slots: [],
      sortGridH: 0,
      dragId: '',
      dragItem: null,
      dragSettling: false,
      gridShift: 0,
      ...extra,
    }, () => {
      wx.nextTick(() => this.setData({ noTrans: false }))
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
        this._exitSort({ sortSaving: false })
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

  // 长按卡片：若未在排序模式则立即进入（类 iOS 长按即编辑），随后进入拖拽态
  onSortLongPress(e) {
    if (!this.data.canSort || this.data.dragId || this.data.dragSettling) return
    const id = e.currentTarget.dataset.id
    const touch = e.touches && e.touches[0]
    if (!touch) return
    if (!this.data.sortMode) {
      // 长按即进排序：两阶段接管完成（槽位坐标系就绪）后再拾取
      this.enterSort(ok => ok && this._beginDrag(id, touch))
    } else {
      this._beginDrag(id, touch)
    }
  },

  // 开始拖拽：拾取瞬间重读 grid 视口位置与滚动偏移（排序态允许滚动，进入时的值可能已过期）
  _beginDrag(id, touch) {
    if (this.data.dragId || !this.data.sortReady) return
    const idx = this.data.sortList.findIndex(d => d._id === id)
    if (idx < 0) return
    const q = wx.createSelectorQuery().in(this)
    q.select('.dish-grid').boundingClientRect()
    q.select('.content-scroll').boundingClientRect()
    q.select('.content-scroll').scrollOffset()
    q.exec(res => {
      if (!res || !res[0] || !res[1]) return
      const gridRect = res[0]
      const svRect = res[1]
      const st = res[2] && typeof res[2].scrollTop === 'number' ? res[2].scrollTop : 0
      this._gridViewX = gridRect.left
      this._gridViewY = gridRect.top
      this._svRect = { top: svRect.top, bottom: svRect.bottom }
      this._baseScrollTop = st
      // 虚拟滚动上限：grid 底边最多滚到 scroll-view 视口底
      this._maxShift = Math.max(0, gridRect.top + this._gridH - svRect.bottom)
      this._gridShift = 0
      this._lastMoveTs = 0

      const slot = this.data.slots[idx]
      if (!slot) return
      const viewX = gridRect.left + slot.sx
      const viewY = gridRect.top + slot.sy
      // 抓取偏移：手指在卡片内的相对位置，跟手全程零跳变
      this._grabOffset = { x: touch.clientX - viewX, y: touch.clientY - viewY }
      this._finger = { x: touch.clientX, y: touch.clientY }
      this.setData({
        dragId: id,
        dragItem: this.data.sortList[idx],
        dragPos: { x: viewX, y: viewY },
        dragSize: { w: slot.w, h: slot.h },
        dragSettling: false,
        // 同步 scroll-top prop：保证松手回同步时目标值必然变化，滚动生效
        scrollTop: st,
      })
      this._vibrate()
      this._startAutoScroll()
    })
  },

  // 拖拽移动：跟手 + 槽位命中换位；边缘自动滚动由定时器持续驱动
  onSortTouchMove(e) {
    if (!this.data.dragId || this.data.dragSettling || !this._grabOffset) return
    const touch = e.touches && e.touches[0]
    if (!touch) return
    this._finger = { x: touch.clientX, y: touch.clientY }
    // 节流 ~16ms（≈60fps），减少 setData 频率保证流畅
    const now = Date.now()
    if (now - this._lastMoveTs < 16) return
    this._lastMoveTs = now

    // 浮层跟手：视口坐标 = 手指位置 − 抓取偏移（手指始终按在卡片同一相对点，零跳变）
    const x = touch.clientX - this._grabOffset.x
    const y = touch.clientY - this._grabOffset.y
    const last = this.data.dragPos
    if (Math.abs(x - last.x) >= 0.5 || Math.abs(y - last.y) >= 0.5) {
      this.setData({ dragPos: { x, y } })
    }
    this._trySwap()
  },

  // 槽位命中：手指内容坐标对固定槽位中心做最近命中，无重测、无 race、无抖动
  _trySwap() {
    const slots = this.data.slots
    const dragId = this.data.dragId
    if (!slots.length || !dragId || !this._finger) return
    const cx = this._finger.x - this._gridViewX
    const cy = this._finger.y - this._gridViewY + this._gridShift
    let target = -1
    let min = Infinity
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]
      const dx = s.sx + s.w / 2 - cx
      const dy = s.sy + s.h / 2 - cy
      const d = dx * dx + dy * dy
      if (d < min) { min = d; target = i }
    }
    const curIdx = this.data.sortList.findIndex(d => d._id === dragId)
    if (target < 0 || curIdx < 0 || target === curIdx) return
    // 插入式换位：被拖项移到目标槽位，其余卡片靠 transform 过渡平滑补位
    const list = this.data.sortList.slice()
    const [moved] = list.splice(curIdx, 1)
    list.splice(target, 0, moved)
    this.setData({ sortList: list })
    this._vibrate()
  },

  // 边缘自动滚动：拖拽中 scroll-view 冻结，用 grid 容器 translateY 做虚拟滚动
  // 16ms 定时器持续驱动：手指悬停不动也持续滚动，GPU 合成 60fps
  _startAutoScroll() {
    this._stopAutoScroll()
    this._scrollTimer = setInterval(() => {
      if (!this._finger || !this._svRect) return
      const EDGE = 50  // px，距 scroll-view 顶/底的触发范围
      const SPEED = 11 // px/帧 最大滚动速度
      const y = this._finger.y
      let delta = 0
      if (y < this._svRect.top + EDGE) {
        delta = -Math.ceil((this._svRect.top + EDGE - y) / EDGE * SPEED)
      } else if (y > this._svRect.bottom - EDGE) {
        delta = Math.ceil((y - (this._svRect.bottom - EDGE)) / EDGE * SPEED)
      }
      if (!delta) return
      const next = Math.max(0, Math.min(this._maxShift, this._gridShift + delta))
      if (next === this._gridShift) return
      this._gridShift = next
      this.setData({ gridShift: next })
      this._trySwap()   // 内容移动后槽位命中需重算
    }, 16)
  },

  _stopAutoScroll() {
    if (this._scrollTimer) { clearInterval(this._scrollTimer); this._scrollTimer = null }
  },

  // 松手：浮层回弹飞回目标槽位，~220ms 后落位
  onSortTouchEnd() {
    if (!this.data.dragId || this.data.dragSettling) return
    this._stopAutoScroll()
    const idx = this.data.sortList.findIndex(d => d._id === this.data.dragId)
    const slot = this.data.slots[idx]
    if (!slot) { this._finishDrag(); return }
    this.setData({
      dragSettling: true,
      dragPos: {
        x: this._gridViewX + slot.sx,
        y: this._gridViewY + slot.sy - this._gridShift,
      },
    })
    this._settleTimer = setTimeout(() => this._finishDrag(), 230)
  },

  // 落位：销毁浮层、恢复槽位卡片；虚拟滚动同帧回同步原生 scrollTop（零跳变）
  _finishDrag() {
    if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null }
    this._stopAutoScroll()
    const target = (this._baseScrollTop || 0) + (this._gridShift || 0)
    this._gridShift = 0
    this._grabOffset = null
    this._finger = null
    this.setData({
      dragId: '',
      dragItem: null,
      dragSettling: false,
      dragPos: { x: 0, y: 0 },
      dragSize: { w: 0, h: 0 },
      gridShift: 0,
      scrollTop: target,
    })
  },

  // 轻震动反馈（拾取/换位），不支持的机型静默兜底
  _vibrate() {
    try { wx.vibrateShort({ type: 'light', fail: () => {} }) } catch (e) {}
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
