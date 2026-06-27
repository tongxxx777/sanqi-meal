const app = getApp()

Page({
  data: {
    isBound: false,
    dishes: [],
    filteredDishes: [],
    search: '',
    loading: true,
    partnerName: '',
    categories: [],
    currentCategory: '',
    categoryCount: {},
    filterLabel: '',
  },

  async onShow() {
    app.setKitchenTitle()
    this.getPartnerName()
    await app.loadCategories()
    this.loadDishes()
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
        createTimeText: this.formatDate(item.createTime)
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      const categories = app.globalData.categories || []
      const categoryCount = {}
      categories.forEach(cat => {
        categoryCount[cat._id] = dishes.filter(d => d.category === cat._id).length
      })

      this.setData({
        dishes,
        categories,
        categoryCount,
        loading: false
      })
      this.filterDishes()
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 选择分类
  selectCategory(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ currentCategory: id })
    this.filterDishes()
  },

  // 搜索
  onSearch(e) {
    const search = e.detail.value.trim()
    this.setData({ search })
    this.filterDishes()
  },

  // 清除搜索
  clearSearch() {
    this.setData({ search: '' })
    this.filterDishes()
  },

  // 过滤菜品
  filterDishes() {
    const { dishes, search, currentCategory, categories } = this.data
    let filtered = dishes

    // 按分类筛选
    if (currentCategory) {
      filtered = filtered.filter(item => item.category === currentCategory)
    }

    // 按搜索词筛选
    if (search) {
      filtered = filtered.filter(item =>
        item.name.toLowerCase().includes(search.toLowerCase())
      )
    }

    // 确定筛选标签：优先搜索词，其次分类名
    let filterLabel = search || ''
    if (!filterLabel && currentCategory) {
      const cat = categories.find(c => c._id === currentCategory)
      filterLabel = cat ? cat.name : ''
    }

    this.setData({ filteredDishes: filtered, filterLabel })
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

      // 更新本地数据
      const dishes = this.data.dishes.filter(item => item._id !== id)
      this.setData({ dishes })
      this.filterDishes()

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
