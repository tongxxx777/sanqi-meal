const app = getApp()

Page({
  data: {
    isBound: false,
    dishes: [],
    allDishes: [],
    categories: [],
    dishesByCategory: {},
    categoryCount: {},
    selectedByCategory: {},
    currentCategory: '',
    leftScrollTop: 0,
    dishScrollTop: 0,
    selectedCount: 0,
    selectedDishes: [],
    loading: true,
    hasLoaded: false,
    showSuccess: false,
    showRemarkModal: false,
    showCartPanel: false,
    showDishDetail: false,
    detailClosing: false,
    currentDish: null,
    detailTranslateY: 0,
    remark: '',
    submitting: false,
    partnerName: '对方',
    searchKey: '',
  },

  async onShow() {
    app.setKitchenTitle()
    this.loadPartnerName()
    await app.loadCategories()
    if (!this.data.hasLoaded) {
      await this.loadDishes()
      this.setData({ hasLoaded: true })
    } else {
      // 保存当前搜索状态
      const savedKey = this.data.searchKey
      // 静默刷新仅更新后台数据，不触发显示层渲染
      const result = await this.refreshDishesSilently()
      if (result) {
        const { allDishes, categories } = result
        const filtered = savedKey
          ? allDishes.filter(d => d.name.includes(savedKey) || (d.description && d.description.includes(savedKey)))
          : allDishes
        const { dishesByCategory, selectedByCategory } = this._syncCategoryData(filtered, categories)
        const categoryCount = {}
        categories.forEach(cat => {
          categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
        })
        const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)
        this.setData({
          allDishes,
          categories,
          dishes: filtered,
          dishesByCategory,
          categoryCount,
          selectedByCategory,
          currentCategory: firstCategory ? firstCategory._id : (categories[0] ? categories[0]._id : ''),
          loading: false
        })
        // 测量分类位置供滚动联动使用
        if (filtered.length > 0) {
          setTimeout(() => { this._measureDishCategoryPositions() }, 200)
        }
      }
    }
  },

  // 获取伴侣名字
  async loadPartnerName() {
    await app.loadUserInfo()
    const partnerName = app.getPartnerName()
    this.setData({ partnerName })
  },

  // 加载菜品
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
      const data = res.result.data

      // 检查是否有再来一单的菜品
      const reorderIds = app.globalData.reorderDishIds ? app.globalData.reorderDishIds.split(',') : []
      app.globalData.reorderDishIds = null

      const dishes = data.map(item => ({
        ...item,
        selected: reorderIds.includes(item._id),
        category: item.category || 'meat'
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      let categories = app.globalData.categories || []
      if (categories.length === 0) {
        // 兜底：分类为空时用菜品自带的 category 值生成临时分组，确保菜品能正常展示
        const catMap = {}
        dishes.forEach(d => {
          const cid = d.category || 'other'
          if (!catMap[cid]) catMap[cid] = { _id: cid, name: cid, icon: '🍽️' }
        })
        categories = Object.values(catMap)
      }

      const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes, categories)
      const categoryCount = {}
      categories.forEach(cat => {
        categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
      })

      const selectedDishes = dishes.filter(d => d.selected)

      // 找到第一个有菜品的分类
      const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)

      this.setData({
        dishes,
        allDishes: dishes,
        categories,
        dishesByCategory,
        categoryCount,
        selectedByCategory,
        selectedDishes,
        selectedCount: selectedDishes.length,
        currentCategory: firstCategory ? firstCategory._id : categories[0]._id,
        loading: false,
        searchKey: '',
        dishScrollTop: 0
      })
      // 等 DOM 渲染完，预测量所有分类在 scroll 内容中的位置
      setTimeout(() => { this._measureDishCategoryPositions() }, 200)

      if (reorderIds.length > 0) {
        wx.showToast({ title: '已选好菜品~', icon: 'none' })
      }
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false })
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

      const data = res.result.data
      const dishes = data.map(item => ({
        ...item,
        selected: false,
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

      // 仅更新 allDishes 和 categories，不写入 dishes/dishesByCategory
      // 避免与搜索状态冲突造成闪屏
      this.setData({ allDishes: dishes, categories, loading: false })
      return { allDishes: dishes, categories }
    } catch (e) {
      console.error('静默刷新菜品失败', e)
      return null
    }
  },

  // 选择分类
  selectCategory(e) {
    const id = e.currentTarget.dataset.id
    const leftPos = this._leftCategoryPositions?.[id] ?? 0
    this.setData({
      currentCategory: id,
      leftScrollTop: leftPos
    })
    // 锁定手动选中，防止滚动动画期间 _syncCategoryHighlight 把高亮切回去
    this._manualSelectId = id
    this._manualSelectTime = Date.now()

    // 用预测量位置精确滚动，彻底避免 boundingClientRect 对视野外元素不准的问题
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
      ? allDishes.filter(d => d.name.includes(searchKey) || (d.description && d.description.includes(searchKey)))
      : allDishes

    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes, categories)
    const categoryCount = {}
    categories.forEach(cat => {
      categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
    })
    const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)

    this.setData({
      dishes,
      dishesByCategory,
      categoryCount,
      selectedByCategory,
      currentCategory: firstCategory ? firstCategory._id : categories[0]._id,
      dishScrollTop: 0
    })
    setTimeout(() => { this._measureDishCategoryPositions() }, 200)
  },

  // 重新按分类整理菜品数据
  _syncCategoryData(dishes, categories) {
    const cats = categories || this.data.categories || []
    const dishesByCategory = {}
    const selectedByCategory = {}
    cats.forEach(cat => {
      const catDishes = dishes.filter(d => d.category === cat._id)
      // 排序：先按点单次数降序，再按创建时间降序
      catDishes.sort((a, b) => {
        const countDiff = (b.orderCount || 0) - (a.orderCount || 0)
        if (countDiff !== 0) return countDiff
        const aTime = a.createTime ? new Date(a.createTime).getTime() : 0
        const bTime = b.createTime ? new Date(b.createTime).getTime() : 0
        return bTime - aTime
      })
      dishesByCategory[cat._id] = catDishes
      selectedByCategory[cat._id] = catDishes.filter(d => d.selected).length
    })
    return { dishesByCategory, selectedByCategory }
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

  // 滚动到底部——强制高亮最后一个分类
  onDishScrollToLower() {
    const visibleCats = this.data.categories.filter(c => this.data.categoryCount[c._id] > 0)
    if (visibleCats.length === 0) return
    const lastCat = visibleCats[visibleCats.length - 1]
    if (lastCat && lastCat._id !== this.data.currentCategory) {
      this._scrollToLowerTime = Date.now()
      const leftPos = this._leftCategoryPositions?.[lastCat._id] ?? 0
      this.setData({
        currentCategory: lastCat._id,
        leftScrollTop: leftPos
      })
    }
  },

  // 预测量所有分类标题在 scroll-view 内容中的位置（scrollTop=0 时测量，保证视野外元素也精确）
  _measureDishCategoryPositions() {
    const cats = this.data.categories.filter(c => this.data.categoryCount[c._id] > 0)
    if (cats.length === 0) return
    // 右侧菜品分类位置测量
    const q1 = this.createSelectorQuery()
    q1.select('.dish-list').boundingClientRect()
    cats.forEach(cat => q1.select(`#cat-${cat._id}`).boundingClientRect())
    q1.exec(res => {
      if (!res || !res[0]) return
      const listTop = res[0].top
      this._categoryPositions = {}
      cats.forEach((cat, i) => {
        if (res[i + 1]) {
          this._categoryPositions[cat._id] = Math.max(0, res[i + 1].top - listTop)
        }
      })
    })
    // 左侧分类位置测量（所有分类都要测，包括无菜品的分类）
    const q2 = this.createSelectorQuery()
    q2.select('.category-list').boundingClientRect()
    this.data.categories.forEach(cat => q2.select(`#catleft-${cat._id}`).boundingClientRect())
    q2.exec(res => {
      if (!res || !res[0]) return
      const listTop = res[0].top
      this._leftCategoryPositions = {}
      this.data.categories.forEach((cat, i) => {
        if (res[i + 1]) {
          this._leftCategoryPositions[cat._id] = Math.max(0, res[i + 1].top - listTop)
        }
      })
    })
  },

  _syncCategoryHighlight() {
    // 手动选分类后 600ms 内暂停自动同步，避免被滚动事件冲掉
    if (this._manualSelectTime && Date.now() - this._manualSelectTime < 600) return
    // 滚动触底后 300ms 内暂停自动同步，避免把最后一个分类高亮冲掉
    if (this._scrollToLowerTime && Date.now() - this._scrollToLowerTime < 300) return

    const visibleCats = this.data.categories.filter(c => this.data.categoryCount[c._id] > 0)
    if (visibleCats.length === 0) return

    const query = this.createSelectorQuery()
    query.select('.dish-list').boundingClientRect()
    visibleCats.forEach(cat => {
      query.select(`#cat-${cat._id}`).boundingClientRect()
    })
    // 额外查询列表底部的占位元素，用于判断是否已滚动到底
    query.select('.list-bottom').boundingClientRect()
    query.exec(rects => {
      if (!rects || !rects[0]) return
      const listTop = rects[0].top + 20
      const listBottom = rects[0].bottom
      let activeId = visibleCats[0]._id
      for (let i = 0; i < visibleCats.length; i++) {
        if (rects[i + 1] && rects[i + 1].top <= listTop) {
          activeId = visibleCats[i]._id
        }
      }
      // 修复：检查最后一个分类是否应该高亮
      const lastIdx = visibleCats.length - 1
      const lastCatRect = rects[lastIdx + 1]
      if (lastCatRect) {
        // 场景1：最后一个分类的标题已经滚动到顶部区域或上方
        if (lastCatRect.top <= listTop) {
          activeId = visibleCats[lastIdx]._id
        }
        // 场景2：列表已滚动到底部（最后一个分类的底部已在可视区域内）
        // rects 最后一个是 .list-bottom 的 rect
        const bottomHintRect = rects[rects.length - 1]
        if (bottomHintRect && bottomHintRect.top <= listBottom) {
          activeId = visibleCats[lastIdx]._id
        }
      }
      if (activeId !== this.data.currentCategory) {
        // 高亮切换加节流：至少间隔 200ms 才更新一次，避免滚动时过度渲染导致闪烁
        const now = Date.now()
        if (!this._lastHighlightTime || now - this._lastHighlightTime > 200) {
          this._lastHighlightTime = now
          const leftPos = this._leftCategoryPositions?.[activeId] ?? 0
          this.setData({
            currentCategory: activeId,
            leftScrollTop: leftPos
          })
        }
      }
    })
  },

  // 切换选中状态
  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    const dishes = this.data.dishes.map(item =>
      item._id === id ? { ...item, selected: !item.selected } : item
    )

    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)
    const selectedDishes = dishes.filter(item => item.selected)

    this.setData({
      dishes,
      dishesByCategory,
      selectedByCategory,
      selectedDishes,
      selectedCount: selectedDishes.length
    })
  },

  // 切换购物车面板
  toggleCartPanel() {
    this.setData({ showCartPanel: !this.data.showCartPanel })
  },

  // 打开菜品详情面板
  openDishDetail(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(d => d._id === id)
    if (dish) {
      this.setData({ showDishDetail: true, currentDish: dish })
    }
  },

  // 关闭菜品详情面板
  closeDishDetail() {
    this.setData({ detailClosing: true, detailTranslateY: 0 })
    setTimeout(() => {
      this.setData({ showDishDetail: false, detailClosing: false, currentDish: null })
    }, 300)
  },

  // 下拉关闭 - 触摸开始
  onDetailTouchStart(e) {
    this.touchStartY = e.touches[0].clientY
    this.isDragging = false
  },

  // 下拉关闭 - 触摸移动
  onDetailTouchMove(e) {
    const currentY = e.touches[0].clientY
    const deltaY = currentY - this.touchStartY
    if (deltaY > 0) {
      this.isDragging = true
      this.setData({ detailTranslateY: deltaY })
    }
  },

  // 下拉关闭 - 触摸结束
  onDetailTouchEnd() {
    const { detailTranslateY } = this.data
    if (detailTranslateY > 150) {
      this.closeDishDetail()
    } else {
      this.setData({ detailTranslateY: 0 })
    }
  },

  // 详情面板中切换选中状态
  toggleDishInDetail() {
    const { currentDish } = this.data
    if (!currentDish) return

    const dishes = this.data.dishes.map(item =>
      item._id === currentDish._id ? { ...item, selected: !item.selected } : item
    )

    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)
    const selectedDishes = dishes.filter(item => item.selected)
    const updatedDish = dishes.find(d => d._id === currentDish._id)

    this.setData({
      dishes,
      dishesByCategory,
      selectedByCategory,
      selectedDishes,
      selectedCount: selectedDishes.length,
      currentDish: updatedDish
    })
  },

  // 从购物车移除
  removeFromCart(e) {
    const id = e.currentTarget.dataset.id
    const dishes = this.data.dishes.map(item =>
      item._id === id ? { ...item, selected: false } : item
    )

    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)
    const selectedDishes = dishes.filter(item => item.selected)

    this.setData({
      dishes,
      dishesByCategory,
      selectedByCategory,
      selectedDishes,
      selectedCount: selectedDishes.length
    })
  },

  // 清空购物车
  clearCart() {
    const dishes = this.data.dishes.map(item => ({ ...item, selected: false }))
    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)

    this.setData({
      dishes,
      dishesByCategory,
      selectedByCategory,
      selectedDishes: [],
      selectedCount: 0,
      showCartPanel: false
    })
  },

  // 提交点菜 - 先弹出备注输入框
  submitOrder() {
    const { selectedDishes, submitting } = this.data

    if (submitting || selectedDishes.length === 0) {
      if (selectedDishes.length === 0) {
        wx.showToast({ title: '请先选择菜品', icon: 'none' })
      }
      return
    }

    // 弹出备注输入框
    this.setData({ showRemarkModal: true, remark: '' })
  },

  // 输入备注
  onRemarkInput(e) {
    let value = e.detail.value
    if (value.length > 100) value = value.slice(0, 100)
    this.setData({ remark: value })
    return value
  },

  // 关闭备注弹窗
  closeRemarkModal() {
    this.setData({ showRemarkModal: false })
  },

  // 阻止冒泡
  preventClose() {},

  // 跳过备注
  skipRemark() {
    this.setData({ showRemarkModal: false })
    this.doSubmitOrder('')
  },

  // 确认备注
  confirmRemark() {
    this.setData({ showRemarkModal: false })
    this.doSubmitOrder(this.data.remark)
  },

  // 实际提交点菜
  async doSubmitOrder(remark) {
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }

    const { selectedDishes } = this.data

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

    try {
      const db = await app.database()

      // 保存点菜记录（带上 coupleId）
      const coupleId = app.globalData.currentUser?.coupleId || ''
      const addRes = await db.collection(app.globalData.collectionOrderList).add({
        data: {
          dishes: selectedDishes.map(item => ({
            _id: item._id,
            name: item.name,
            imageUrl: item._raw_imageUrl || item.imageUrl || '',
            category: item.category
          })),
          remark,
          coupleId,
          status: 'pending', // 待处理状态
          createTime: db.serverDate(),
        }
      })
      const orderId = addRes._id

      // 更新菜品点单次数（异步执行，不阻塞）
      for (const dish of selectedDishes) {
        wx.cloud.callFunction({
          name: 'updateCoupleData',
          data: {
            collection: app.globalData.collectionDishList,
            docId: dish._id,
            action: 'inc',
            data: { orderCount: 1 }
          }
        }).catch(() => {})
      }

      // 发送通知
      await this.sendNotification(selectedDishes, remark, orderId)

      wx.hideLoading()
      // 显示成功弹窗
      this.setData({
        showSuccess: true,
        submitting: false
      })

    } catch (e) {
      wx.hideLoading()
      console.error('点菜失败', e)
      wx.showToast({ title: '点菜失败，请重试', icon: 'none' })
      this.setData({ submitting: false })
    }
  },

  // 发送通知
  async sendNotification(dishes, remark, orderId) {
    const dishNames = dishes.map(d => d.name).join('、')
    try {
      await wx.cloud.callFunction({
        name: 'sendNotify',
        data: {
          type: 'newOrder',
          templateId: app.globalData.notifyTmplIds[0],
          dishNames,
          count: dishes.length,
          remark,
          orderId
        }
      })
    } catch (e) {
      // 通知发送失败不影响主流程
    }
  },

  // 关闭成功弹窗
  closeSuccess() {
    const dishes = this.data.dishes.map(item => ({ ...item, selected: false }))
    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)

    this.setData({
      showSuccess: false,
      dishes,
      dishesByCategory,
      selectedByCategory,
      selectedDishes: [],
      selectedCount: 0
    })
  },

  // 跳转到菜品库
  goToDishes() {
    wx.switchTab({ url: '/pages/dishes/index' })
  },

  // 分享给好友
  onShareAppMessage() {
    const { partnerName } = this.data
    return {
      title: `今天吃什么？和${partnerName}一起来点菜吧`,
      path: '/pages/order/index',
      imageUrl: '/images/default.jpg'
    }
  },
})
