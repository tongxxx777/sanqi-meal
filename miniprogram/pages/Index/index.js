const app = getApp()

Page({
  data: {
    pageLoading: true,
    greeting: '你好',
    userName: '',
    userAvatar: '',
    partnerName: '',
    partnerAvatar: '',
    bindDays: 0,
    todayOrders: [],
    dishCount: 0,
    orderCount: 0,
    isBound: false,
    profileComplete: false,
  },

  // 是否已完成首次加载
  hasLoaded: false,

  onLoad() {
    this.setGreeting()
  },

  async onShow() {
    const isFirstLoad = !this.hasLoaded
    // 首次进入显示 loading，之后直接显示页面（数据静默更新，不闪 loading）
    if (isFirstLoad) {
      this.setData({ pageLoading: true })
    }
    app.setKitchenTitle()
    // 用户信息（冷启动 bootstrap，之后内存命中）
    await app.loadUserInfo()
    // 版本校验：每次 onShow 直连读 CoupleMeta，对方有修改则精准重拉对应数据
    await app.syncOnShow('home')
    this.renderAll()
    if (isFirstLoad) {
      this.hasLoaded = true
      this.setData({ pageLoading: false })
    }
  },

  // 从 globalData + homeStore + counts 渲染整页（唯一数据源）
  renderAll() {
    const { currentUser, partner } = app.globalData
    const isBound = app.isBound()

    // 计算绑定天数
    let bindDays = 0
    if (isBound && currentUser?.bindTime) {
      const bindTime = new Date(currentUser.bindTime)
      const now = new Date()
      bindDays = Math.floor((now - bindTime) / (1000 * 60 * 60 * 24)) + 1
    }

    const { dishCount, orderCount } = app.globalData.counts

    this.setData({
      userName: currentUser?.nickname || '',
      userAvatar: currentUser?.avatarUrl || '',
      partnerName: partner?.nickname || '',
      partnerAvatar: partner?.avatarUrl || '',
      bindDays,
      isBound,
      profileComplete: app.isProfileComplete(),
      todayOrders: isBound ? this.computeTodayOrders() : [],
      dishCount: isBound ? dishCount : 0,
      orderCount: isBound ? orderCount : 0
    })
  },

  // 由 homeStore 原始订单计算"今天食用"的列表（按期望用餐日聚合）
  computeTodayOrders() {
    const now = new Date()
    const currentUserId = app.globalData.currentUser?._id
    return (app.globalData.homeStore.orders || [])
      // 计算有效用餐时间：优先期望时间，老数据兜底用创建时间
      .map(o => ({ ...o, _eff: o.expectTime ? new Date(o.expectTime) : new Date(o.createTime) }))
      // 只保留"今天食用"的
      .filter(o => this.isSameDay(o._eff, now))
      // 按用餐时间从早到晚排
      .sort((a, b) => a._eff - b._eff)
      .map(o => {
        if (!o.status) o.status = 'pending'
        return {
          ...o,
          creatorName: app.getDisplayName(o._openid),
          isCreator: o._openid === currentUserId,
          // 本区块只含"今日食用"的单，直接显示档位/时刻，
          // 不用下单时冻结的 expectText（隔天会显示成"明天"）
          timeText: this.todayOrderTimeText(o)
        }
      })
  },

  // 今日点餐的期望时间文案：今日就是今日，只显示档位或具体时刻
  todayOrderTimeText(o) {
    if (!o.expectTime) return o.expectText || this.formatTime(o.createTime)
    const SLOT_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
    return SLOT_LABEL[o.expectSlot] || o.expectTimeText || this.formatTime(o.expectTime)
  },

  // 下拉刷新（3s 防抖）- 强制版本校验 + 重拉变化数据
  async onPullDownRefresh() {
    const now = Date.now()
    if (now - app.globalData.lastPullTs < 3000) {
      wx.stopPullDownRefresh()
      return
    }
    app.globalData.lastPullTs = now
    try {
      await app.loadUserInfo(true)
      await app.syncOnShow('home', { force: true })
      this.renderAll()
    } catch (e) {
      console.error('首页下拉刷新失败', e)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  // 设置问候语
  setGreeting() {
    const hour = new Date().getHours()
    let greeting = '你好'
    if (hour < 6) greeting = '夜深了'
    else if (hour < 9) greeting = '早上好'
    else if (hour < 12) greeting = '上午好'
    else if (hour < 14) greeting = '中午好'
    else if (hour < 18) greeting = '下午好'
    else if (hour < 22) greeting = '晚上好'
    else greeting = '夜深了'
    this.setData({ greeting })
  },

  // 判断两个日期是否同一天
  isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear()
      && d1.getMonth() === d2.getMonth()
      && d1.getDate() === d2.getDate()
  },

  // 格式化时间
  formatTime(date) {
    if (!date) return ''
    const d = new Date(date)
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  },


  // 跳转到点餐页
  goToOrder() {
    wx.switchTab({ url: '/pages/order/index' })
  },

  // 跳转到今日订单详情
  goToTodayOrder(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  // 跳转到绑定页
  goToBind() {
    wx.navigateTo({ url: '/pages/bind/index' })
  },

  // 跳转到设置页
  goToSettings() {
    wx.navigateTo({ url: '/pages/settings/index' })
  },

  // 跳转到分类管理
  goToCategoryManage() {
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/category-manage/index' })
  },

  // 跳转到设置 profile
  goToSetProfile() {
    wx.navigateTo({ url: '/pages/settings/index?editProfile=true' })
  },

  // 分享给好友
  onShareAppMessage() {
    const app = getApp()
    const partnerName = this.data.partnerName || 'TA'
    const isBound = this.data.isBound
    return {
      title: isBound ? `和${partnerName}的专属小厨房 · ${app.getKitchenName()}` : app.getKitchenName() + ' · 和TA的专属小厨房',
      path: '/pages/index/index',
      imageUrl: '/images/default.jpg'
    }
  },

  // 分享到朋友圈
  onShareTimeline() {
    const app = getApp()
    return {
      title: app.getKitchenName() + ' · 和TA的专属小厨房',
      query: '',
      imageUrl: '/images/default.jpg'
    }
  },
})
