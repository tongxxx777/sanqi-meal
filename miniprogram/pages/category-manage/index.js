const app = getApp()

Page({
  data: {
    categories: [],
    loading: true,
    // 添加/编辑弹窗
    showModal: false,
    editingIndex: -1,
    tempName: '',
    tempIcon: '🍽️',
    emojiList: ['🥩', '🥬', '🍲', '🍚', '🍜', '🥗', '🍰', '🥤', '🍳', '🍕', '🌮', '🍣', '🥘', '🍝', '🥙', '🍱', '🧁', '🍺', '☕', '🫕', '🍽️', '🔥', '⭐', '🌶️'],
    customIcon: '',
    // 删除转移弹窗
    showTransferModal: false,
    deletingCategory: null,
    deletingDishCount: 0,
    transferTarget: '',
    transferOptions: [],
    sortChanged: false,
    // 排序模式
    sortMode: false,
    draggingIndex: -1,
    dragOffset: 0,
    // 其他行的让位位移（px，与 categories 等长）
    shifts: [],
    // 松手重排瞬间关闭过渡，避免复位动画闪烁
    animOff: false,
  },

  async onShow() {
    await this.loadCategories()
  },

  async loadCategories() {
    this.setData({ loading: true })
    try {
      // 版本校验（对方增删改/排序过分类会自动重拉），分类从全局 store 读取
      await app.syncOnShow('category-manage')
      this.setData({ categories: app.globalData.categories })
    } catch (e) {
      console.error('load categories error', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
    this.setData({ loading: false })
  },

  // 显示添加弹窗
  showAddModal() {
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }
    this.setData({
      showModal: true,
      editingIndex: -1,
      tempName: '',
      tempIcon: '🍽️',
      customIcon: ''
    })
  },

  // 点击分类进入编辑
  editCategory(e) {
    const index = e.currentTarget.dataset.index
    const cat = this.data.categories[index]
    this.setData({
      showModal: true,
      editingIndex: index,
      tempName: cat.name,
      tempIcon: cat.icon
    })
  },

  selectEmoji(e) {
    this.setData({ tempIcon: e.currentTarget.dataset.emoji, customIcon: '' })
  },

  onCustomIconInput(e) {
    this.setData({ customIcon: e.detail.value })
  },

  useCustomIcon() {
    if (this.data.customIcon) {
      this.setData({ tempIcon: this.data.customIcon })
    }
  },

  onNameInput(e) {
    let value = e.detail.value
    if (value.length > 6) value = value.slice(0, 6)
    this.setData({ tempName: value })
    return value
  },

  closeModal() {
    this.setData({ showModal: false })
  },

  // 保存分类（新增或编辑）
  async saveCategory() {
    const { tempName, tempIcon, editingIndex, categories } = this.data
    if (!tempName.trim()) {
      wx.showToast({ title: '请输入分类名称', icon: 'none' })
      return
    }

    wx.showLoading({ title: '保存中...', mask: true })

    try {
      if (editingIndex >= 0) {
        // 编辑
        const res = await wx.cloud.callFunction({
          name: 'manageCategory',
          data: {
            action: 'update',
            data: { _id: categories[editingIndex]._id, name: tempName.trim(), icon: tempIcon }
          }
        })
        if (!res.result?.success) {
          throw new Error(res.result?.message || '保存失败')
        }
        // 用响应里的新版本号同步本地 store（其他页面立即可见，无需重拉）
        app.applyCategoryUpdated(
          { _id: categories[editingIndex]._id, name: tempName.trim(), icon: tempIcon },
          res.result.categoryVer
        )
      } else {
        // 新增
        const res = await wx.cloud.callFunction({
          name: 'manageCategory',
          data: {
            action: 'add',
            data: { name: tempName.trim(), icon: tempIcon }
          }
        })
        if (!res.result?.success) {
          throw new Error(res.result?.message || '保存失败')
        }
        // 用响应里的完整新文档同步本地 store
        app.applyCategoryAdded(res.result.doc, res.result.categoryVer)
      }

      wx.hideLoading()
      this.setData({ showModal: false, categories: app.globalData.categories })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('save category error', e)
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  // 删除分类
  async deleteCategory(e) {
    if (this.data.categories.length <= 1) {
      wx.showToast({ title: '至少保留一个分类', icon: 'none' })
      return
    }
    const index = e.currentTarget.dataset.index
    const cat = this.data.categories[index]

    wx.showLoading({ title: '检查中...', mask: true })

    try {
      // 查询该分类下菜品数量
      const res = await wx.cloud.callFunction({
        name: 'manageCategory',
        data: { action: 'countDishes', data: { _id: cat._id } }
      })
      wx.hideLoading()

      const count = res.result?.count || 0

      if (count === 0) {
        // 无菜品，直接确认删除
        wx.showModal({
          title: '确认删除',
          content: `确定删除「${cat.icon} ${cat.name}」分类？`,
          success: async (modalRes) => {
            if (!modalRes.confirm) return
            wx.showLoading({ title: '删除中...', mask: true })
            const delRes = await wx.cloud.callFunction({
              name: 'manageCategory',
              data: { action: 'remove', data: { _id: cat._id } }
            })
            wx.hideLoading()
            if (!delRes.result?.success) {
              wx.showToast({ title: delRes.result?.message || '删除失败', icon: 'none' })
              return
            }
            // 用响应里的新版本号同步本地 store
            app.applyCategoryRemoved(cat._id, delRes.result.categoryVer)
            this.setData({ categories: app.globalData.categories })
            wx.showToast({ title: '已删除', icon: 'success' })
          }
        })
      } else {
        // 有菜品，弹出转移弹窗
        const transferOptions = this.data.categories.filter(c => c._id !== cat._id)
        this.setData({
          showTransferModal: true,
          deletingCategory: cat,
          deletingDishCount: count,
          transferTarget: '',
          transferOptions
        })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('delete category error', e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  selectTransferTarget(e) {
    this.setData({ transferTarget: e.currentTarget.dataset.id })
  },

  closeTransferModal() {
    this.setData({ showTransferModal: false })
  },

  // 确认转移并删除
  async confirmDelete() {
    const { deletingCategory, transferTarget } = this.data
    if (!transferTarget) return

    wx.showLoading({ title: '转移中...', mask: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageCategory',
        data: {
          action: 'remove',
          data: { _id: deletingCategory._id, transferTo: transferTarget }
        }
      })
      wx.hideLoading()
      if (!res.result?.success) {
        wx.showToast({ title: res.result?.message || '操作失败', icon: 'none' })
        return
      }

      // 分类写回本地 store
      app.applyCategoryRemoved(deletingCategory._id, res.result.categoryVer)
      // 菜品被批量转移了分类：重拉菜品并同步 dishVer（菜品库/点餐页立即可见）
      if (typeof res.result.dishVer === 'number') {
        await app.reloadDishes()
        app.applyVersions({ dishVer: res.result.dishVer })
      }

      this.setData({ showTransferModal: false, categories: app.globalData.categories })
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('transfer and delete error', e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // 切换排序模式：进入直接切；退出时有改动则自动保存（保存失败则留在排序模式）
  async toggleSortMode() {
    if (!this.data.sortMode) {
      this.setData({ sortMode: true })
      return
    }
    if (this.data.sortChanged) {
      await this.saveSortOrder()
      if (this.data.sortChanged) return
    }
    this.setData({ sortMode: false, draggingIndex: -1, dragOffset: 0, shifts: [], animOff: false })
    this._drag = null
    this._dragStarting = false
    this._dragAbort = false
  },

  // 排序模式下长按行（drag-layer 触发）：开始拖拽
  async onDragStart(e) {
    if (!this.data.sortMode || this._drag || this._dragStarting) return
    const index = e.currentTarget.dataset.index
    const touch = e.touches && e.touches[0]
    if (!touch) return
    await this.startDrag(index, touch)
  },

  // 非排序模式长按分类：进入排序模式并直接开始拖动该行
  async onRowLongPress(e) {
    if (this.data.sortMode || this._drag || this._dragStarting) return
    const index = e.currentTarget.dataset.index
    const touch = e.touches && e.touches[0]
    if (!touch) return
    this.setData({ sortMode: true })
    await this.startDrag(index, touch)
  },

  // 拖拽初始化：测行高、震动、记录起点
  async startDrag(index, touch) {
    this._dragStarting = true
    try {
      // 测量行高（卡片高度 + 下边距）
      const rowH = await new Promise(resolve => {
        wx.createSelectorQuery()
          .select('.category-item')
          .boundingClientRect(rect => {
            const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
            const rpx = win.windowWidth / 750
            resolve(rect ? rect.height + 16 * rpx : 120 * rpx)
          })
          .exec()
      })
      // 测量期间手指已抬起：放弃启动，避免行卡在拖拽态
      if (this._dragAbort) {
        this._dragAbort = false
        return
      }
      try { wx.vibrateShort({ type: 'light' }) } catch (err) {}
      this._drag = { startY: touch.clientY, origin: index, target: index, rowH }
      this.setData({
        draggingIndex: index,
        dragOffset: 0,
        shifts: this.data.categories.map(() => 0)
      })
    } finally {
      this._dragStarting = false
    }
  },

  // 拖拽移动：拖动项贴手指，其他行 translateY 滑动让位（不重排数组，避免错位）
  onDragMove(e) {
    const d = this._drag
    if (!d) return
    const touch = e.touches && e.touches[0]
    if (!touch) return

    const deltaY = touch.clientY - d.startY
    const n = this.data.categories.length
    const { origin, rowH } = d
    const target = Math.max(0, Math.min(n - 1, origin + Math.round(deltaY / rowH)))

    const update = { dragOffset: deltaY }
    if (target !== d.target) {
      d.target = target
      // 让位规则：目标在下，(origin, target] 的行上移一行；目标在上，[target, origin) 的行下移一行
      update.shifts = this.data.categories.map((_, i) => {
        if (i === origin) return 0
        if (target > origin && i > origin && i <= target) return -rowH
        if (target < origin && i >= target && i < origin) return rowH
        return 0
      })
    }
    this.setData(update)
  },

  // 拖拽结束：此刻才真正重排数组，复位时关闭过渡防止闪烁
  onDragEnd() {
    const d = this._drag
    if (!d) {
      // startDrag 测量未完成就抬手：作废本次启动
      if (this._dragStarting) this._dragAbort = true
      return
    }
    this._drag = null

    const { origin, target } = d
    if (target === origin) {
      this.setData({ draggingIndex: -1, dragOffset: 0, shifts: [] })
      return
    }

    const categories = this.data.categories.slice()
    const moved = categories.splice(origin, 1)[0]
    categories.splice(target, 0, moved)

    this.setData({
      categories,
      sortChanged: true,
      draggingIndex: -1,
      dragOffset: 0,
      shifts: [],
      animOff: true
    })
    // DOM 重排完成后恢复过渡动画
    setTimeout(() => this.setData({ animOff: false }), 50)
  },

  // 保存排序
  async saveSortOrder() {
    const orders = this.data.categories.map((cat, i) => ({ _id: cat._id, sort: i }))
    wx.showLoading({ title: '保存中...', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageCategory',
        data: { action: 'reorder', data: { orders } }
      })
      wx.hideLoading()
      if (!res.result?.success) {
        wx.showToast({ title: res.result?.message || '保存失败', icon: 'none' })
        return
      }
      // 用响应里的新版本号同步本地 store（含最新 sort 值）
      const newList = this.data.categories.map((cat, i) => Object.assign({}, cat, { sort: i }))
      app.applyCategoryMutation(newList, res.result.categoryVer)
      this.setData({ sortChanged: false })
      wx.showToast({ title: '排序已保存', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '保存失败', icon: 'none' })
    }
  },

  preventBubble() {},
})
