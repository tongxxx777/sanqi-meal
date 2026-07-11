const app = getApp()

// 用餐类型档位（time 为该档位默认时刻，24 小时制）
const SLOT_OPTIONS = [
  { key: 'breakfast', label: '早餐', time: '07:00' },
  { key: 'lunch',     label: '午餐', time: '12:00' },
  { key: 'dinner',    label: '晚餐', time: '18:00' },
]

Page({
  data: {
    isBound: false,
    dishes: [],
    // ===== 期望用餐时间 =====
    dateOptions: [],        // [{label:'今天', dateStr:'2026-07-10', month, day}]
    expectDateIndex: 0,     // 选中的日期下标
    slotOptions: [],        // 带 disabled 的档位列表
    expectSlot: '',         // 选中的档位 key
    expectTimeStr: '',      // 具体时刻 24h "HH:mm"（提交/校验用）
    expectTimeLabel: '',    // 具体时刻 12h 中文（展示用）
    customTimeStr: '',      // 自定义 picker 默认展示值（未选自定义时=下一个整点）
    expectText: '',         // 预览文案
    timeStart: '00:00',     // picker 可选起始时间（选"今天"时为当前时刻）
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
    notifyFailed: false,
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
    this.initExpect()
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

  // ==================== 期望用餐时间 ====================

  // 初始化：构建日期选项 + 默认档位
  initExpect() {
    const dateOptions = this.buildExpectDateOptions()
    this._expectPref = this._loadExpectPref()   // 缓存本次会话偏好
    this.setData({ dateOptions, expectDateIndex: 0 }, () => {
      this.refreshSlots()      // 计算各档位是否过期
      // 默认选中「上一次点的档位」，若当天已过期则退回第一个可用档位
      const last = this._expectPref?.lastSlot
      if (last) {
        const lastSlot = this.data.slotOptions.find(s => s.key === last && !s.disabled)
        if (lastSlot) {
          let t
          if (last === 'custom') {
            t = this._expectPref?.times?.['custom'] || this._nextHourStr()
            // 今天且自定义时间已过 → 用下一个整点
            if (this.data.expectDateIndex === 0 && !this._isTimeFuture(t)) t = this._nextHourStr()
          } else {
            t = this._slotTime(last, this._expectPref)
          }
          this.setData({ expectSlot: last, expectTimeStr: t, expectTimeLabel: this.format12h(t) }, () => this.updatePreview())
          return
        }
      }
      this.pickDefaultSlot()
    })
  },

  // 构建今天/明天两个日期选项
  buildExpectDateOptions() {
    const labels = ['今天', '明天']
    const today = new Date()
    const opts = []
    for (let i = 0; i < 2; i++) {
      const d = new Date(today)
      d.setDate(today.getDate() + i)
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      opts.push({ label: labels[i], dateStr, month: d.getMonth() + 1, day: d.getDate() })
    }
    return opts
  },

  // 24h "HH:mm" -> 12h 中文：上午10:00 / 中午12:00 / 下午5:00
  format12h(hhmm) {
    if (!hhmm) return ''
    let [h, m] = hhmm.split(':').map(Number)
    const ap = h === 12 ? '中午' : (h < 12 ? '上午' : '下午')
    let h12 = h % 12
    if (h12 === 0) h12 = 12
    return `${ap}${h12}:${String(m).padStart(2, '0')}`
  },

  // 选"今天"时，当前时间 ≥ 档位时间则置灰；选"明天"时全部可选
  isSlotDisabled(slot) {
    if (this.data.expectDateIndex !== 0) return false
    const now = new Date()
    const [h, m] = slot.time.split(':').map(Number)
    const slotMin = h * 60 + m
    const nowMin = now.getHours() * 60 + now.getMinutes()
    return nowMin >= slotMin
  },

  // 重新计算档位 disabled 状态 + picker 起始时间
  refreshSlots() {
    const slotOptions = SLOT_OPTIONS.map(s => ({ ...s, disabled: this.isSlotDisabled(s) }))
    // 追加"自定义"档位，始终可选
    slotOptions.push({ key: 'custom', label: '自定义', time: '', disabled: false })
    // 选"今天"时，picker 最早只能选当前时刻
    let timeStart = '00:00'
    if (this.data.expectDateIndex === 0) {
      const now = new Date()
      timeStart = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    }
    this.setData({ slotOptions, timeStart, customTimeStr: this._nextHourStr() })
  },

  // 选中第一个未过期的档位；若早/午/晚全过期则默认选"自定义"+当前时间
  pickDefaultSlot() {
    const avail = this.data.slotOptions.find(s => !s.disabled)
    if (!avail) return
    let t
    if (avail.key === 'custom') {
      t = this._nextHourStr()
    } else {
      t = this._slotTime(avail.key, this._expectPref) || avail.time
    }
    this.setData({
      expectSlot: avail.key,
      expectTimeStr: t,
      expectTimeLabel: this.format12h(t)
    }, () => this.updatePreview())
  },

  // 选择日期
  selectExpectDate(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ expectDateIndex: index }, () => {
      this.refreshSlots()
      // 切换日期后，若当前选中的档位在新日期下已过期，重新选默认档位
      const cur = this.data.slotOptions.find(s => s.key === this.data.expectSlot)
      if (!cur || cur.disabled) {
        this.pickDefaultSlot()
      } else {
        this.updatePreview()
      }
    })
  },

  // 选择档位
  selectExpectSlot(e) {
    const key = e.currentTarget.dataset.key
    const slot = this.data.slotOptions.find(s => s.key === key)
    if (!slot || slot.disabled) return
    const t = this._slotTime(key, this._expectPref) || slot.time
    this.setData({ expectSlot: key, expectTimeStr: t, expectTimeLabel: this.format12h(t) }, () => this.updatePreview())
  },

  // 自定义时间选择（picker bindchange）
  onCustomTimeChange(e) {
    const t = e.detail.value
    this.setData({ expectSlot: 'custom', expectTimeStr: t, expectTimeLabel: this.format12h(t), customTimeStr: t }, () => this.updatePreview())
  },

  // 自定义档位默认时间：当前时刻向上取整到下一个整点（如 9:30 → 10:00）
  _nextHourStr() {
    const now = new Date()
    const h = (now.getHours() + 1) % 24
    return `${String(h).padStart(2, '0')}:00`
  },

  // 判断某时间在今天是否还未到
  _isTimeFuture(hhmm) {
    if (this.data.expectDateIndex !== 0) return true
    const now = new Date()
    const [h, m] = hhmm.split(':').map(Number)
    return (h * 60 + m) > (now.getHours() * 60 + now.getMinutes())
  },

  // 更新预览文案
  updatePreview() {
    const expect = this._buildExpect()
    this.setData({ expectText: expect ? expect.expectText : '' })
  },

  // 组装期望时间字段（数据不完整时返回 null）
  _buildExpect() {
    const { expectDateIndex, expectSlot, expectTimeStr, dateOptions, slotOptions } = this.data
    if (!expectTimeStr || !dateOptions[expectDateIndex]) return null
    const slot = slotOptions.find(s => s.key === expectSlot)
    const [hh, mm] = expectTimeStr.split(':').map(Number)
    const [Y, M, D] = dateOptions[expectDateIndex].dateStr.split('-').map(Number)
    const expectTime = new Date(Y, M - 1, D, hh, mm)
    const timeLabel = this.format12h(expectTimeStr)
    const slotLabel = (!slot || slot.key === 'custom') ? '' : slot.label
    const dateLabel = dateOptions[expectDateIndex].label
    const expectText = `${dateLabel} ${timeLabel}${slotLabel ? ' · ' + slotLabel : ''}`
    return {
      expectTime,
      expectDateText: dateLabel,
      expectTimeText: timeLabel,
      expectSlot: expectSlot || 'custom',
      expectText
    }
  },

  // 某档位应使用的时间：记忆优先，否则 SLOT 默认
  _slotTime(slotKey, pref) {
    if (pref?.times?.[slotKey]) return pref.times[slotKey]
    const def = SLOT_OPTIONS.find(s => s.key === slotKey)
    return def ? def.time : ''
  },

  // 读取偏好（按 openid 区分媳妇/你）
  _loadExpectPref() {
    try {
      const id = app.globalData.currentUser?._id
      return id ? (wx.getStorageSync('expectPref_' + id) || null) : null
    } catch (e) { return null }
  },

  // 保存偏好：各档位各自时间 + 上次选的档位
  _saveExpectPref(lastSlot, times) {
    try {
      const id = app.globalData.currentUser?._id
      if (id) wx.setStorageSync('expectPref_' + id, { lastSlot, times })
    } catch (e) {}
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

      const dishes = this._mapDishes(data)

      let categories = this._resolveCategories(dishes)

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
      const dishes = this._mapDishes(data)

      let categories = this._resolveCategories(dishes)

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

  // 将原始菜品数据映射为页面展示结构
  _mapDishes(data) {
    return data.map(item => ({
      ...item,
      selected: false,
      category: item.category || 'meat'
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
    if (value.length > 50) value = value.slice(0, 50)
    this.setData({ remark: value })
    return value
  },

  // 关闭备注弹窗
  closeRemarkModal() {
    this.setData({ showRemarkModal: false })
  },

  // 阻止冒泡
  preventClose() {},

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

    // 校验期望用餐时间
    const expect = this._buildExpect()
    if (!expect) {
      wx.showToast({ title: '请选择期望用餐时间', icon: 'none' })
      return
    }

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
            imageUrl: item.imageUrl || '',
            category: item.category
          })),
          remark,
          coupleId,
          status: 'pending', // 待处理状态
          createTime: db.serverDate(),
          // 期望用餐时间
          expectTime: expect.expectTime,
          expectDateText: expect.expectDateText,
          expectTimeText: expect.expectTimeText,
          expectSlot: expect.expectSlot,
          expectText: expect.expectText,
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

      // 发送通知（fire，不依赖其脆弱返回值判定，避免"对方已收到却误判失败"）
      await this.sendNotification(selectedDishes, remark, orderId, expect.expectText)

      // 以云函数写回的 notifyStatus 为准：服务端已成功发送会写 'sent'
      let notifyFailed = false
      try {
        const r = await wx.cloud.callFunction({
          name: 'getCoupleData',
          data: { collection: app.globalData.collectionOrderList, docId: orderId }
        })
        notifyFailed = r.result?.data?.notifyStatus === 'failed'
      } catch (e) {
        // 读不到回执则保守按成功处理，不冤枉对方已收到的消息
        notifyFailed = false
      }

      wx.hideLoading()
      // 记住本次选择：更新对应档位时间 + 记录上次选的档位
      const slot = expect.expectSlot
      const prev = this._expectPref || {}
      const times = { ...(prev.times || {}) }
      if (slot) times[slot] = expect.expectTimeStr
      this._saveExpectPref(slot, times)
      // 显示成功弹窗
      this.setData({
        showSuccess: true,
        submitting: false,
        notifyFailed
      })

    } catch (e) {
      wx.hideLoading()
      console.error('点菜失败', e)
      wx.showToast({ title: '点菜失败，请重试', icon: 'none' })
      this.setData({ submitting: false })
    }
  },

  // 发送通知
  async sendNotification(dishes, remark, orderId, expectText) {
    const dishNames = dishes.map(d => d.name).join('、')
    try {
      const res = await wx.cloud.callFunction({
        name: 'sendNotify',
        data: {
          type: 'newOrder',
          templateId: app.globalData.notifyTmplIds[0],
          dishNames,
          count: dishes.length,
          remark,
          orderId,
          expectText: expectText || ''
        }
      })
      // 通知发送失败（如对方授权额度耗尽）不影响点菜主流程，但需暴露出来便于排查
      if (!res.result?.success) {
        console.error('[sendNotification] 通知未送达：', res.result?.message || res.result?.error)
      }
      return res.result
    } catch (e) {
      console.error('[sendNotification] 通知发送异常', e)
      return null
    }
  },

  // 关闭成功弹窗
  closeSuccess() {
    const dishes = this.data.dishes.map(item => ({ ...item, selected: false }))
    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)

    this.setData({
      showSuccess: false,
      notifyFailed: false,
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
