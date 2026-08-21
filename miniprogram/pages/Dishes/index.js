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
    if (resetState) {
      this._scrollToListTop()
    }
  },

  // 回顶：页面级滚动直接滚回 0（瞬时无动画，与之前行为一致）
  _scrollToListTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
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
  async onPullDownRefresh() {
    const now = Date.now()
    if (now - app.globalData.lastPullTs < 3000) {
      wx.stopPullDownRefresh()
      return
    }
    app.globalData.lastPullTs = now
    try {
      await app.syncOnShow('dishes', { force: true })
      this.renderFromStore({ resetState: true })
    } catch (e) {
      console.error('dishes onPullDownRefresh error', e)
    } finally {
      wx.stopPullDownRefresh()
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
        dishesByCategory[cat._id] = dishes
      } else {
        dishesByCategory[cat._id] = dishes.filter(d => d.category === cat._id)
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
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(item => item._id === id)
    const imageUrl = dish?.imageUrl ? encodeURIComponent(dish.imageUrl) : ''
    wx.navigateTo({ url: `/pages/dish-detail/index?id=${id}&imageUrl=${imageUrl}` })
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
