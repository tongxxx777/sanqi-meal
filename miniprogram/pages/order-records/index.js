const app = getApp()
const imageCache = require('../../utils/imageCache.js')

Page({
  data: {
    isBound: false,
    orders: [],
    loading: true,
    hasLoaded: false,
    hasMore: true,
    page: 0,
    pageSize: 10,
    openid: '',
    partnerName: '',
    showTipModal: false,
    tipText: '',
    // 下拉刷新状态
    refresherTriggered: false,
    // 引导：首条左滑演示
    guideTimer: null,
    showGuideBubble: false,
  },

  async onShow() {
    app.setKitchenTitle()
    await this.loadUserInfo()
    const isFirst = !this.data.hasLoaded
    // 版本校验：每次 onShow 直连读 CoupleMeta，对方有修改则精准重拉对应数据
    const r = await app.syncOnShow('records')
    if (isFirst) {
      this.setData({ hasLoaded: true })
      this.renderFromStore()
    } else {
      // 用渲染序号判断本端/对方数据是否变化（版本号机制只感知对方写入、感知不到本端写入）
      const needRender = app.checkRenderSeq(this, ['order', 'user'])
      if (needRender) {
        // 订单/用户信息有变化才重渲染；无变化时不动页面，零闪屏
        this.renderFromStore()
      } else {
        this.setData({ loading: false })
      }
    }
    // 记录当前渲染快照，供下次 onShow 比对
    app.markRenderSeq(this, ['order', 'user'])

    // 首次进入播放左滑引导（仅一次，本地缓存记录）
    this.maybePlayGuide()
  },

  // 首次进入时演示第一张卡片左滑露出标记/删除按钮
  maybePlayGuide() {
    if (this.data.guideTimer) return // 已在演示中
    if (wx.getStorageSync('historyGuideShown')) return
    if (!this.data.orders || this.data.orders.length === 0) return
    if (this.data.orders[0].guideShow) return

    const id = this.data.orders[0]._id
    // 先滑出 + 气泡浮现
    this.setGuideState(id, true, true)
    // 停留约 3 秒后收回 + 气泡淡出，并标记已看过
    this.data.guideTimer = setTimeout(() => {
      this.setGuideState(id, false, false)
      wx.setStorageSync('historyGuideShown', true)
      this.data.guideTimer = null
    }, 3000)
  },

  // 按订单 id 设置首条引导滑出/气泡显隐（防止演示期间列表刷新导致错位）
  setGuideState(orderId, guideShow, bubble) {
    const orders = this.data.orders
    const index = orders.findIndex(o => o._id === orderId)
    if (index === -1) {
      this.setData({ showGuideBubble: false })
      return
    }
    orders[index].guideShow = guideShow
    this.setData({ orders, showGuideBubble: bubble })
  },

  // 清理引导定时器，避免页面切走后误触发 setData
  clearGuideTimer() {
    if (this.data.guideTimer) {
      clearTimeout(this.data.guideTimer)
      this.data.guideTimer = null
    }
  },

  // 加载用户信息
  async loadUserInfo() {
    const { currentUser, partner } = await app.loadUserInfo()
    this.setData({
      openid: currentUser?._id || '',
      partnerName: partner?.nickname || '对方'
    })
  },

  // 从 historyStore 渲染第一页（唯一数据源）
  renderFromStore() {
    const store = app.globalData.historyStore
    const orders = store.orders.map(o => this._mapOrder(o))
    // 给首条订单附加 guideShow 字段，供首次进入时演示左滑
    if (orders.length) orders[0].guideShow = false
    this.setData({
      orders,
      hasMore: store.hasMore,
      page: store.page,
      loading: false,
      refresherTriggered: false
    })
  },

  // 原始订单 -> 页面展示结构
  _mapOrder(item) {
    return {
      ...item,
      // 处理旧数据：如果没有 status 字段，默认为 'pending'
      status: item.status || 'pending',
      // 菜品图本地持久缓存优先，未命中走 cloud:// 并后台落盘
      dishes: (item.dishes || []).map(d => ({
        ...d,
        _localImg: imageCache.resolve(d.imageUrl) || d.imageUrl || ''
      })),
      dateText: this.formatDate(item.createTime),
      timeText: this.formatTime(item.createTime),
      expectText: this.expectDisplayText(item),
      creatorName: this.getCreatorName(item._openid),
      slideButtons: this.getSlideButtons(item.marked)
    }
  },

  // 期望用餐时间展示文案（与首页小饭桌 mealTimeText 逻辑同步）：
  // 当天餐（期望日=下单日）只显示档位/时刻（如"午餐"）；次日餐（期望日=下单日+1）显示"明天 xx"。
  // 判定基准是"下单日"而非查看时的今天——历史单显示稳定不随时间变化，也不动数据库
  expectDisplayText(order) {
    const SLOT_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
    // 核心时段：优先结构化字段（与首页同款优先级）
    let core = SLOT_LABEL[order.expectSlot] || order.expectTimeText || ''
    if (!core && order.expectTime) core = this.formatTime(order.expectTime)
    // 极老数据兜底：仅冻结文案可用。"今天 xx"截前缀，"明天 xx"原样保留（次日餐）
    if (!core && order.expectText) {
      if (/^明天\s*/.test(order.expectText)) return order.expectText
      return order.expectText.replace(/^今天\s*/, '')
    }
    if (!core) return ''
    // 次日订单：期望用餐日 = 下单日 + 1 天 → 带"明天"前缀
    if (order.expectTime && order.createTime) {
      const eff = new Date(order.expectTime)
      const c = new Date(order.createTime)
      c.setDate(c.getDate() + 1)
      const isNextDay = eff.getFullYear() === c.getFullYear()
        && eff.getMonth() === c.getMonth() && eff.getDate() === c.getDate()
      if (isNextDay) return `明天 ${core}`
    }
    return core
  },

  // 加载更多（第 2 页起由页面自行分页加载）
  async loadOrders() {
    this.setData({ loading: true })

    try {
      const { page, pageSize, orders: existingOrders } = this.data

      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionOrderList,
          orderBy: 'createTime',
          order: 'desc',
          skip: page * pageSize,
          limit: pageSize
        }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.message || '加载失败')
      }

      const data = res.result.data
      const newOrders = data.map(item => this._mapOrder(item))

      this.setData({
        orders: [...existingOrders, ...newOrders],
        hasMore: data.length === pageSize,
        page: page + 1,
        loading: false
      })
    } catch (e) {
      console.error('加载历史失败', e)
      this.setData({ loading: false })
    }
  },

  // 加载更多
  loadMore() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadOrders()
    }
  },

  // 获取创建者名字
  getCreatorName(openid) {
    return app.getDisplayName(openid)
  },

  // 格式化日期
  formatDate(date) {
    if (!date) return ''
    const d = new Date(date)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    if (d.toDateString() === today.toDateString()) {
      return '今天'
    } else {
      const month = (d.getMonth() + 1).toString().padStart(2, '0')
      const day = d.getDate().toString().padStart(2, '0')
      return `${month}月${day}日`
    }
  },

  // 格式化时间
  formatTime(date) {
    if (!date) return ''
    const d = new Date(date)
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  },

  // 获取滑动按钮配置（deleteDisabled 为 true 时删除按钮呈禁用态）
  getSlideButtons(marked, deleteDisabled = false) {
    return [
      { text: marked ? '取消' : '标记', type: 'default', extClass: 'mark-btn' },
      { text: '删除', type: 'warn', extClass: deleteDisabled ? 'delete-btn btn-disabled' : 'delete-btn' }
    ]
  },

  // 滑动按钮点击处理
  onSlideButtonTap(e) {
    const { index } = e.detail
    const id = e.currentTarget.dataset.id
    if (index === 0) {
      this.toggleMark(id)
    } else {
      const target = this.data.orders.find(item => item._id === id)
      if (target?.deleteDisabled) {
        this.showTip('这条记录不能删除哦~')
        return
      }
      this.deleteOrder(id)
    }
  },

  // 切换标记状态
  async toggleMark(id) {
    const orders = this.data.orders
    const index = orders.findIndex(item => item._id === id)
    if (index === -1) return

    const newMarked = !orders[index].marked
    wx.showLoading({ title: '处理中...', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'updateCoupleData',
        data: {
          collection: app.globalData.collectionOrderList,
          docId: id,
          action: 'update',
          data: { marked: newMarked }
        }
      })

      wx.hideLoading()

      if (!res.result?.success) {
        this.showTip(res.result?.message || '标记失败')
        return
      }

      // 用响应里的新版本号同步本地 store（对方切 tab 时版本校验会感知）
      app.applyOrderUpdated(id, { marked: newMarked }, res.result.ver)

      orders[index].marked = newMarked
      orders[index].slideButtons = this.getSlideButtons(newMarked)
      this.setData({ orders })
      wx.showToast({ title: newMarked ? '已标记' : '已取消标记', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('标记失败', e)
      this.showTip('标记失败了，再试一次吧~')
    }
  },

  // 删除订单（一次云函数完成：删单 + 批量回收 orderCount + 版本维护）
  deleteOrder(id) {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条点餐记录吗？',
      confirmColor: '#E57373',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...', mask: true })
          try {
            const result = await wx.cloud.callFunction({
              name: 'updateCoupleData',
              data: {
                action: 'removeOrder',
                collection: app.globalData.collectionOrderList,
                docId: id
              }
            })

            wx.hideLoading()

            if (!result.result?.success) {
              setTimeout(() => this.showTip(result.result?.message || '删除失败'), 300)
              return
            }

            // 用响应里的新版本号同步本地 store（首页小饭桌同步移除）
            app.applyOrderRemoved(id, result.result.ver)
            // 本地菜品 orderCount 乐观 -1（云端已批量回收，这里同步本地展示）
            const target = this.data.orders.find(item => item._id === id)
            if (target?.dishes?.length) {
              app.bumpDishOrderCount(target.dishes.map(d => d._id).filter(Boolean), -1)
            }

            const orders = this.data.orders.filter(item => item._id !== id)
            this.setData({ orders })
            wx.showToast({ title: '已删除', icon: 'success' })
          } catch (e) {
            wx.hideLoading()
            console.error('删除失败', e)
            setTimeout(() => this.showTip('只能删除自己点的菜哦~'), 300)
          }
        }
      }
    })
  },

  // 显示提示弹窗
  showTip(text) {
    this.setData({ showTipModal: true, tipText: text })
  },

  // 关闭提示弹窗
  closeTipModal() {
    this.setData({ showTipModal: false })
  },

  // 阻止冒泡
  preventClose() {},

  // 再来一单：把该单菜品重新选入点餐页（替换当前已选）
  async onReorderTap(e) {
    const id = e.currentTarget.dataset.id
    const order = this.data.orders.find(item => item._id === id)
    if (!order || !order.dishes || !order.dishes.length) return

    // 订单菜品 id 去重（订单为历史快照，防御性处理）
    const ids = [...new Set(order.dishes.map(d => d._id).filter(Boolean))]

    // 冷启动直落历史页时菜品库可能未加载，先补拉一次
    if (!app.globalData.dishStore.loaded) {
      wx.showLoading({ title: '准备中...', mask: true })
      await app.reloadDishes()
      wx.hideLoading()
      if (!app.globalData.dishStore.dishes.length) {
        wx.showToast({ title: '菜品加载失败，请重试', icon: 'none' })
        return
      }
    }

    // 只保留菜单里仍存在的菜
    const live = app.globalData.dishStore.dishes
    const liveIds = ids.filter(i => live.some(d => d._id === i))
    const missingCount = ids.length - liveIds.length

    // 全部失效：不跳转
    if (liveIds.length === 0) {
      wx.showToast({ title: '这些菜已经不在菜单里啦', icon: 'none' })
      return
    }

    // 写入信箱由点餐页 onShow 消费（switchTab 无法带参）
    app.globalData.pendingReorder = { ids: liveIds, missingCount }
    wx.switchTab({ url: '/pages/order/index' })
  },

  // 跳转到详情页
  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  // 下拉刷新（系统级，页面无 scroll-view 时可触发；当前使用 scroll-view 内置 refresher）
  async onPullDownRefresh() {
    try {
      await app.syncOnShow('records', { force: true })
      this.renderFromStore()
    } finally {
      wx.stopPullDownRefresh()
    }
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
      await app.syncOnShow('records', { force: true })
      this.renderFromStore()
    } catch (e) {
      console.error('history onRefresh error', e)
    } finally {
      this.setData({ refresherTriggered: false })
    }
  },

  // 上拉加载
  onReachBottom() {
    this.loadMore()
  },

  // 分享给好友
  onShareAppMessage() {
    return {
      title: '看看我们的点餐记录',
      path: '/pages/order-records/index',
      imageUrl: '/images/default.jpg'
    }
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: getApp().getKitchenName() + ' · 美食记忆',
      query: '',
      imageUrl: '/images/default.jpg'
    }
  },

  // 页面隐藏/卸载时清理引导定时器
  onHide() {
    this.clearGuideTimer()
  },

  onUnload() {
    this.clearGuideTimer()
  },
})
