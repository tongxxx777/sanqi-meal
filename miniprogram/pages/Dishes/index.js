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
    // 回顶标记：仅在需要回到顶部时置 true，下一帧复位，平时为空让 scroll-view 自由滚动
    scrollToTop: false,
    loading: true,
    hasLoaded: false,
    partnerName: '',
    searchKey: '',
    // 下拉刷新状态
    refresherTriggered: false,
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
      loading: false,
      refresherTriggered: false
    })
    if (resetState) {
      this._scrollToListTop()
    }
  },

  // 让菜品列表回到顶部（scroll-into-view 方式，避免受控 scroll-top 造成的卡底/回弹）
  _scrollToListTop() {
    this.setData({ scrollToTop: true })
    setTimeout(() => this.setData({ scrollToTop: false }), 100)
  },

  // 获取伴侣名字
  async getPartnerName() {
    await app.loadUserInfo()
    const partnerName = app.getPartnerName()
    this.setData({ partnerName })
  },

  // 下拉刷新（3s 防抖）- 强制版本校验 + 重拉变化数据
  async onRefresh() {
    const now = Date.now()
    if (now - app.globalData.lastPullTs < 3000) {
      this.setData({ refresherTriggered: false })
      return
    }
    app.globalData.lastPullTs = now
    this.setData({ refresherTriggered: true })
    try {
      await app.syncOnShow('dishes', { force: true })
      this.renderFromStore({ resetState: true })
    } catch (e) {
      console.error('dishes onRefresh error', e)
    } finally {
      this.setData({ refresherTriggered: false })
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
    const allCat = { _id: '__all__', name: '全部', icon: '📋' }
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

  // 长按删除确认
  showDeleteConfirm(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(item => item._id === id)
    wx.showModal({
      title: '删除菜品',
      content: `确定要删除「${dish.name}」吗？`,
      confirmColor: '#E53935',
      success: async (res) => {
        if (res.confirm) {
          await this.deleteDish(id)
        }
      }
    })
  },

  // 删除菜品
  async deleteDish(id) {
    wx.showLoading({ title: '删除中...', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'updateCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          docId: id,
          action: 'remove'
        }
      })

      wx.hideLoading()

      if (!res.result?.success) {
        throw new Error(res.result?.message || '删除失败')
      }

      // 用响应里的新版本号同步本地 store（删缓存→写最新→立即展示，无需重拉）
      app.applyDishRemoved(id, res.result.ver)
      this.renderFromStore({ resetState: false })
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('删除失败', e)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
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
