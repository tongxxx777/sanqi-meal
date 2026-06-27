const app = getApp()

Page({
  data: {
    isBound: false,
    dishes: [],
    allDishes: [],
    categories: [],
    dishesByCategory: {},
    categoryCount: {},
    currentCategory: '',
    categoryScrollId: '',
    dishScrollTop: 0,
    loading: true,
    hasLoaded: false,
    partnerName: '',
    searchKey: '',
  },

  async onShow() {
    app.setKitchenTitle()
    this.getPartnerName()
    await app.loadCategories()
    if (!this.data.hasLoaded) {
      await this.loadDishes()
      this.setData({ hasLoaded: true })
    } else {
      this.refreshDishesSilently()
    }
  },

  // 获取伴侣名字
  async getPartnerName() {
    await app.loadUserInfo()
    const partnerName = app.getPartnerName()
    this.setData({ partnerName })
  },

  // 加载菜品列表
  async loadDishes() {
    this.setData({ loading: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          orderBy: 'createTime',
          order: 'desc',
          limit: 100
        }
      })
      if (!res.result?.success) {
        throw new Error(res.result?.message || '加载失败')
      }

      let dishes = res.result.data.map(item => ({
        ...item,
        createTimeText: this.formatDate(item.createTime),
        category: item.category || 'meat'
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      let categories = app.globalData.categories || []
      if (categories.length === 0) {
        const catMap = {}
        dishes.forEach(d => {
          const cid = d.category || 'other'
          if (!catMap[cid]) catMap[cid] = { _id: cid, name: cid, icon: '🍽️' }
        })
        categories = Object.values(catMap)
      }

      const { dishesByCategory } = this._syncCategoryData(dishes, categories)
      const categoryCount = {}
      categories.forEach(cat => {
        categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
      })

      const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)

      this.setData({
        dishes,
        allDishes: dishes,
        categories,
        dishesByCategory,
        categoryCount,
        currentCategory: firstCategory ? firstCategory._id : (categories[0] ? categories[0]._id : ''),
        loading: false,
        searchKey: '',
        dishScrollTop: 0
      })
      setTimeout(() => { this._measureDishCategoryPositions() }, 200)
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 静默刷新菜品
  async refreshDishesSilently() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          orderBy: 'createTime',
          order: 'desc',
          limit: 100
        }
      })
      if (!res.result?.success) return

      let dishes = res.result.data.map(item => ({
        ...item,
        createTimeText: this.formatDate(item.createTime),
        category: item.category || 'meat'
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      let categories = app.globalData.categories || []
      if (categories.length === 0) {
        const catMap = {}
        dishes.forEach(d => {
          const cid = d.category || 'other'
          if (!catMap[cid]) catMap[cid] = { _id: cid, name: cid, icon: '🍽️' }
        })
        categories = Object.values(catMap)
      }

      const { dishesByCategory } = this._syncCategoryData(dishes, categories)
      const categoryCount = {}
      categories.forEach(cat => {
        categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
      })

      this.setData({
        allDishes: dishes,
        dishesByCategory,
        categoryCount,
        dishes,
        categories,
        loading: false,
      })
    } catch (e) {
      console.error('静默刷新菜品失败', e)
    }
  },

  // 重新按分类整理菜品数据
  _syncCategoryData(dishes, categories) {
    const cats = categories || this.data.categories || []
    const dishesByCategory = {}
    cats.forEach(cat => {
      dishesByCategory[cat._id] = dishes.filter(d => d.category === cat._id)
    })
    return { dishesByCategory }
  },

  // 选择分类
  selectCategory(e) {
    const id = e.currentTarget.dataset.id
    this.setData({
      currentCategory: id,
      categoryScrollId: `catleft-${id}`
    })
    this._manualSelectId = id
    this._manualSelectTime = Date.now()

    const pos = this._categoryPositions && this._categoryPositions[id]
    if (pos !== undefined && pos !== null) {
      this.setData({ dishScrollTop: pos })
    }
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
    const { allDishes, categories } = this.data
    let dishes = searchKey
      ? allDishes.filter(d =>
          d.name.includes(searchKey) ||
          (d.description && d.description.includes(searchKey))
        )
      : allDishes

    const { dishesByCategory } = this._syncCategoryData(dishes, categories)
    const categoryCount = {}
    categories.forEach(cat => {
      categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
    })
    const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)

    this.setData({
      dishes,
      dishesByCategory,
      categoryCount,
      currentCategory: firstCategory ? firstCategory._id : (categories[0] ? categories[0]._id : ''),
      dishScrollTop: 0
    })
    setTimeout(() => { this._measureDishCategoryPositions() }, 200)
  },

  // 监听右侧滚动，同步左侧高亮
  onDishScroll(e) {
    this._dishScrollTop = e.detail.scrollTop
    if (this._scrollTimer) return
    this._scrollTimer = setTimeout(() => {
      this._scrollTimer = null
      this._syncCategoryHighlight()
    }, 100)
  },

  // 预测量所有分类标题位置
  _measureDishCategoryPositions() {
    const cats = this.data.categories.filter(c => this.data.categoryCount[c._id] > 0)
    if (cats.length === 0) return
    const q = this.createSelectorQuery()
    q.select('.dish-list').boundingClientRect()
    cats.forEach(cat => q.select(`#cat-${cat._id}`).boundingClientRect())
    q.exec(res => {
      if (!res || !res[0]) return
      const listTop = res[0].top
      this._categoryPositions = {}
      cats.forEach((cat, i) => {
        if (res[i + 1]) {
          this._categoryPositions[cat._id] = Math.max(0, res[i + 1].top - listTop)
        }
      })
    })
  },

  _syncCategoryHighlight() {
    if (this._manualSelectTime && Date.now() - this._manualSelectTime < 600) return

    const visibleCats = this.data.categories.filter(c => this.data.categoryCount[c._id] > 0)
    if (visibleCats.length === 0) return

    const query = this.createSelectorQuery()
    query.select('.dish-list').boundingClientRect()
    visibleCats.forEach(cat => {
      query.select(`#cat-${cat._id}`).boundingClientRect()
    })
    query.exec(rects => {
      if (!rects || !rects[0]) return
      const listTop = rects[0].top + 20
      let activeId = visibleCats[0]._id
      for (let i = 0; i < visibleCats.length; i++) {
        if (rects[i + 1] && rects[i + 1].top <= listTop) {
          activeId = visibleCats[i]._id
        }
      }
      if (activeId !== this.data.currentCategory) {
        const now = Date.now()
        if (!this._lastHighlightTime || now - this._lastHighlightTime > 200) {
          this._lastHighlightTime = now
          this.setData({ currentCategory: activeId })
        }
      }
    })
  },

  // 跳转到添加页
  toAddPage() {
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

      const dishes = this.data.dishes.filter(item => item._id !== id)
      const { dishesByCategory } = this._syncCategoryData(dishes)
      const categoryCount = {}
      this.data.categories.forEach(cat => {
        categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
      })

      this.setData({ dishes, allDishes: dishes, dishesByCategory, categoryCount })
      setTimeout(() => { this._measureDishCategoryPositions() }, 200)
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
      imageUrl: '/images/share.jpg'
    }
  },
})
