const app = getApp()

Page({
  data: {
    isBound: false,
    dishes: [],
    allDishes: [],
    categories: [],
    dishesByCategory: {},
    categoryCount: {},
    currentCategory: '__all__',
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
      // 保存当前搜索/分类状态
      const savedKey = this.data.searchKey
      const savedCat = this.data.currentCategory
      // 静默刷新仅更新后台数据，不触发显示层渲染
      const result = await this.refreshDishesSilently()
      // 用最新数据 + 保存的状态，一次 setData 完成渲染，杜绝闪屏
      if (result) {
        const { allDishes, categories } = result
        const filtered = savedKey
          ? allDishes.filter(d => d.name.includes(savedKey) || (d.description && d.description.includes(savedKey)))
          : allDishes
        const { dishesByCategory } = this._syncCategoryData(filtered, categories)
        const { categories: catsWithAll, dishesByCategory: dbcWithAll, categoryCount } =
          this._prependAllCategory(filtered, categories, dishesByCategory)
        this.setData({
          allDishes,
          categories: catsWithAll,
          dishes: filtered,
          dishesByCategory: dbcWithAll,
          categoryCount,
          currentCategory: savedCat || '__all__',
          loading: false
        })
      }
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
      const { categories: catsWithAll, dishesByCategory: dbcWithAll, categoryCount } =
        this._prependAllCategory(dishes, categories, dishesByCategory)

      this.setData({
        dishes,
        allDishes: dishes,
        categories: catsWithAll,
        dishesByCategory: dbcWithAll,
        categoryCount,
        currentCategory: '__all__',
        loading: false,
        searchKey: '',
        dishScrollTop: 0
      })
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 静默刷新菜品（仅更新后台数据，不触发显示渲染，返回原始数据供调用方使用）
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
      if (!res.result?.success) return null

      let dishes = res.result.data.map(item => ({
        ...item,
        createTimeText: this.formatDate(item.createTime),
        category: item.category || 'meat'
      }))

      let categories = app.globalData.categories || []
      if (categories.length === 0) {
        const catMap = {}
        dishes.forEach(d => {
          const cid = d.category || 'other'
          if (!catMap[cid]) catMap[cid] = { _id: cid, name: cid, icon: '🍽️' }
        })
        categories = Object.values(catMap)
      }

      // 仅更新 allDishes 和 categories，不写入 dishes/dishesByCategory
      // 避免与搜索/分类状态冲突造成闪屏
      this.setData({ allDishes: dishes, categories, loading: false })
      return { allDishes: dishes, categories }
    } catch (e) {
      console.error('静默刷新菜品失败', e)
      return null
    }
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
    this.setData({ currentCategory: id, dishScrollTop: 0 })
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
      currentCategory: '__all__',
      dishScrollTop: 0
    })
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

      const dishes = this.data.dishes.filter(item => item._id !== id)
      const { dishesByCategory } = this._syncCategoryData(dishes)
      const categoryCount = {}
      this.data.categories.forEach(cat => {
        categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
      })

      this.setData({ dishes, allDishes: dishes, dishesByCategory, categoryCount })
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
