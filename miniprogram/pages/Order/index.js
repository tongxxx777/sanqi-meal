const app = getApp()
const imageCache = require('../../utils/imageCache.js')

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
    showRemarkModal: false,
    showCartPanel: false,
    previewImageUrl: '',
    showImagePreview: false,
    remark: '',
    submitting: false,
    orderId: '',
    partnerName: '对方',
    searchKey: '',
    searchFocus: false, // 搜索框焦点态：onHide 时置 false 主动失焦，防止切回 tab 自动弹键盘
    // 下拉刷新状态
    refresherTriggered: false,
  },

  async onShow() {
    app.setKitchenTitle()
    this.loadPartnerName()
    this.initExpect()
    const isFirst = !this.data.hasLoaded
    // 再来一单：消费历史页写入的选中集合（一次性，读完即清，避免下次 onShow 误触发）
    const reorder = app.globalData.pendingReorder || null
    app.globalData.pendingReorder = null
    // 版本校验：每次 onShow 直连读 CoupleMeta，对方有修改则精准重拉对应数据
    const r = await app.syncOnShow('order')
    if (isFirst) {
      this.setData({ hasLoaded: true })
      this.renderFromStore({ resetState: true, selectIds: reorder && reorder.ids })
    } else {
      // 用渲染序号判断本端/对方数据是否变化（版本号机制只感知对方写入、感知不到本端写入，
      // 故删菜/加菜后需靠 renderSeq 触发重渲染，避免返回页面仍显示旧数据）
      const needRender = app.checkRenderSeq(this, ['dish', 'category'])
      if (reorder || needRender) {
        // 菜品/分类有变化才重渲染（保留已选菜品与搜索状态）；无变化时不动页面；
        // 再来一单时用订单菜品替换当前选中并清空搜索词
        this.renderFromStore({ resetState: false, selectIds: reorder && reorder.ids })
      } else {
        this.setData({ loading: false })
      }
    }
    // 记录当前渲染快照，供下次 onShow 比对
    app.markRenderSeq(this, ['dish', 'category'])

    // 再来一单结果提示（部分菜品可能已不在菜单）
    if (reorder) {
      const msg = reorder.missingCount > 0
        ? `已选 ${reorder.ids.length} 道，另有 ${reorder.missingCount} 道不在菜单啦`
        : `已为你选好 ${reorder.ids.length} 道菜～`
      wx.showToast({ title: msg, icon: 'none', duration: 2000 })
    }
  },

  // tab 切走时主动失焦搜索框：
  // input 原生焦点在 tab 页 hide 后残留，切回时微信会自动恢复焦点呼出键盘
  onHide() {
    if (this.data.searchFocus) {
      this.setData({ searchFocus: false })
    }
  },

  // 从共享 dishStore 渲染（唯一数据源）
  renderFromStore(options = {}) {
    const { resetState = false, selectIds = null } = options
    // selectIds：再来一单显式指定选中集合（替换语义），同时清空搜索词避免选中菜被过滤隐藏
    const selectedIds = selectIds || (resetState ? [] : this.data.allDishes.filter(d => d.selected).map(d => d._id))
    const savedKey = selectIds ? '' : (resetState ? '' : this.data.searchKey)

    let dishes = this._mapDishes(app.globalData.dishStore.dishes)
    if (selectedIds.length > 0) {
      dishes = dishes.map(d => selectedIds.includes(d._id) ? { ...d, selected: true } : d)
    }

    const categories = this._resolveCategories(dishes)
    const filtered = savedKey
      ? dishes.filter(d => d.name.includes(savedKey) || (d.description && d.description.includes(savedKey)))
      : dishes

    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(filtered, categories)
    const categoryCount = {}
    categories.forEach(cat => {
      categoryCount[cat._id] = (dishesByCategory[cat._id] || []).length
    })
    const selectedDishes = filtered.filter(d => d.selected)
    const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)

    this.setData({
      dishes: filtered,
      allDishes: dishes,
      categories,
      dishesByCategory,
      categoryCount,
      selectedByCategory,
      selectedDishes,
      selectedCount: selectedDishes.length,
      currentCategory: firstCategory ? firstCategory._id : (categories[0] ? categories[0]._id : ''),
      searchKey: savedKey,
      loading: false,
      refresherTriggered: false
    })
    // 等 DOM 渲染完，预测量所有分类在 scroll 内容中的位置
    if (filtered.length > 0) {
      setTimeout(() => { this._measureDishCategoryPositions() }, 200)
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

  // 24h "HH:mm" -> 12h 中文时段标签
  // 凌晨 00:00-05:59 / 早上 06:00-08:59 / 上午 09:00-11:59
  // 中午 12:00-12:59 / 下午 13:00-17:59 / 晚上 18:00-23:59
  format12h(hhmm) {
    if (!hhmm) return ''
    let [h, m] = hhmm.split(':').map(Number)
    let ap
    if (h === 12) ap = '中午'
    else if (h < 6) ap = '凌晨'
    else if (h < 9) ap = '早上'
    else if (h < 12) ap = '上午'
    else if (h < 18) ap = '下午'
    else ap = '晚上'
    let h12 = h % 12
    if (h12 === 0) h12 = 12
    return `${ap} ${h12}:${String(m).padStart(2, '0')}`
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
    const isCustom = !slot || slot.key === 'custom'
    // 仅自定义显示具体时间；早/午/晚只显示档位名
    const timeLabel = isCustom ? this.format12h(expectTimeStr) : ''
    const slotLabel = isCustom ? '' : slot.label
    const dateLabel = dateOptions[expectDateIndex].label
    const middle = [timeLabel, slotLabel].filter(Boolean).join(' · ')
    const expectText = `${dateLabel} ${middle}`.trim()
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
      await app.syncOnShow('order', { force: true })
      this.renderFromStore({ resetState: true })
    } catch (e) {
      console.error('order onRefresh error', e)
    } finally {
      this.setData({ refresherTriggered: false })
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

  // 搜索框聚焦：把 focus 属性同步为 true（需经历 true→false 才能在 onHide 时真正失焦）
  onSearchFocus() {
    if (!this.data.searchFocus) this.setData({ searchFocus: true })
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
    return (data || []).map(item => ({
      ...item,
      selected: false,
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
    const selectedByCategory = {}
    cats.forEach(cat => {
      const catDishes = dishes.filter(d => d.category === cat._id)
      // 排序：sort 升序优先（有 sort 的排前面），无 sort 按 createTime 倒序排后面
      // 与菜品库一致，两页所见即所得；点单次数仍展示但不参与排序
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
  // 关键：allDishes 是选中态唯一数据源，dishes 只是当前搜索结果的子集。
  // 若只更新 dishes，换关键词搜索时 filterDishes 会从 allDishes 重建列表，选中态丢失
  // （表现为搜第二个菜选中后，第一个菜被覆盖）
  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    const allDishes = this.data.allDishes.map(item =>
      item._id === id ? { ...item, selected: !item.selected } : item
    )
    const dishes = this.data.dishes.map(item =>
      item._id === id ? { ...item, selected: !item.selected } : item
    )

    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)
    // 已选集合从全量数据计算，跨搜索关键词的选中不丢失
    const selectedDishes = allDishes.filter(item => item.selected)

    this.setData({
      dishes,
      allDishes,
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

  // 打开图片预览（点击缩略图，整屏展示原图）
  previewImage(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(d => d._id === id)
    if (dish) {
      this.setData({
        showImagePreview: true,
        previewImageUrl: dish._localImg || dish.imageUrl || '/images/default.jpg'
      })
    }
  },

  // 关闭图片预览
  closePreview() {
    this.setData({ showImagePreview: false, previewImageUrl: '' })
  },

  // 从购物车移除
  // 同步更新 allDishes：被移除的菜可能不在当前搜索结果里，只改 dishes 会移除无效
  removeFromCart(e) {
    const id = e.currentTarget.dataset.id
    const allDishes = this.data.allDishes.map(item =>
      item._id === id ? { ...item, selected: false } : item
    )
    const dishes = this.data.dishes.map(item =>
      item._id === id ? { ...item, selected: false } : item
    )

    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)
    const selectedDishes = allDishes.filter(item => item.selected)

    this.setData({
      dishes,
      allDishes,
      dishesByCategory,
      selectedByCategory,
      selectedDishes,
      selectedCount: selectedDishes.length
    })
  },

  // 清空购物车（两份列表同步置空，防止搜索过滤掉的菜残留选中态）
  clearCart() {
    const allDishes = this.data.allDishes.map(item => ({ ...item, selected: false }))
    const dishes = this.data.dishes.map(item => ({ ...item, selected: false }))
    const { dishesByCategory, selectedByCategory } = this._syncCategoryData(dishes)

    this.setData({
      dishes,
      allDishes,
      dishesByCategory,
      selectedByCategory,
      selectedDishes: [],
      selectedCount: 0,
      showCartPanel: false
    })
  },

  // 提交点餐 - 先弹出备注输入框
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

  // 实际提交点餐（一次云函数完成：写订单 + 批量 orderCount+1 + 版本维护）
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
      const res = await wx.cloud.callFunction({
        name: 'updateCoupleData',
        data: {
          action: 'submitOrder',
          data: {
            dishes: selectedDishes.map(item => ({
              _id: item._id,
              name: item.name,
              imageUrl: item.imageUrl || '',
              category: item.category
            })),
            remark,
            // 期望用餐时间
            expectTime: expect.expectTime,
            expectDateText: expect.expectDateText,
            expectTimeText: expect.expectTimeText,
            expectSlot: expect.expectSlot,
            expectText: expect.expectText,
          }
        }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.message || '点餐失败')
      }

      const orderId = res.result._id

      // 用响应里的完整订单与新版本号同步本地 store（首页小饭桌立即可见，无需重拉）
      app.applyOrderAdded(res.result.doc, res.result.ver)
      // 本地菜品 orderCount 乐观 +1（不触发 dishVer，避免整库重拉）
      app.bumpDishOrderCount(selectedDishes.map(d => d._id), 1)

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
        orderId
      })

    } catch (e) {
      wx.hideLoading()
      console.error('点餐失败', e)
      wx.showToast({ title: '点餐失败，请重试', icon: 'none' })
      this.setData({ submitting: false })
    }
  },

  // 关闭成功弹窗
  closeSuccess() {
    // 重置购物车并跳转订单详情页
    const cart = wx.getStorageSync('cart') || []
    const newCart = cart.filter(item => !item.checked || item.checked === false)
    wx.setStorageSync('cart', newCart)

    wx.redirectTo({
      url: '/pages/order-detail/index?id=' + this.data.orderId
    })
  },

  // 关闭成功弹窗（仅关闭弹窗，不跳转）
  dismissSuccess() {
    const cart = wx.getStorageSync('cart') || []
    const newCart = cart.filter(item => !item.checked || item.checked === false)
    wx.setStorageSync('cart', newCart)
    this.setData({ showSuccess: false })
  },

  // 跳转到菜品库
  goToDishes() {
    wx.switchTab({ url: '/pages/dishes/index' })
  },

  // 分享给好友
  onShareAppMessage() {
    const { partnerName, orderId } = this.data
    // 如果刚下单成功，分享卡片指向订单详情页
    if (orderId) {
      return {
        title: `饭点好了，就等你来确认啦💌`,
        path: `/pages/order-detail/index?id=${orderId}`,
        imageUrl: '/images/default.jpg'
      }
    }
    return {
      title: `想吃点什么？和我一起来点餐吧`,
      path: '/pages/order/index',
      imageUrl: '/images/default.jpg'
    }
  },
})
