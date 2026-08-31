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
    mealOrders: [],      // 今天+明天合并渲染列表（明天单项带 _preview 标记）
    tableEmptyText: '',  // 小饭桌空状态文案（今天无单时展示）
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
      ...this.computeMealSection(isBound),
      dishCount: isBound ? dishCount : 0,
      orderCount: isBound ? orderCount : 0
    })
  },

  // 小饭桌区块数据：今明两天订单 + 空状态文案（未绑定时全部置空）
  computeMealSection(isBound) {
    if (!isBound) {
      return { todayOrders: [], mealOrders: [], tableEmptyText: '' }
    }
    const { today, tomorrow } = this.computeMealOrders()
    return {
      todayOrders: today,
      // 合并渲染：今天单在前，明天单置后并标记 _preview（弱化预告样式）
      mealOrders: [...today, ...tomorrow],
      tableEmptyText: this.computeTableEmptyText(today, tomorrow)
    }
  },

  // 由 homeStore 原始订单计算"今天/明天食用"的两组列表（按期望用餐日聚合，滚动窗口）
  computeMealOrders() {
    const now = new Date()
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const currentUserId = app.globalData.currentUser?._id
    const groups = { today: [], tomorrow: [] }
    ;(app.globalData.homeStore.orders || [])
      // 计算有效用餐时间：优先期望时间，老数据兜底用创建时间
      .map(o => ({ ...o, _eff: o.expectTime ? new Date(o.expectTime) : new Date(o.createTime) }))
      .forEach(o => {
        if (this.isSameDay(o._eff, now)) groups.today.push(o)
        else if (this.isSameDay(o._eff, tomorrow)) groups.tomorrow.push(o)
      })
    // 各组内按用餐时间从早到晚排
    groups.today.sort((a, b) => a._eff - b._eff)
    groups.tomorrow.sort((a, b) => a._eff - b._eff)
    const decorate = (o, isTomorrow) => {
      if (!o.status) o.status = 'pending'
      return {
        ...o,
        creatorName: app.getDisplayName(o._openid),
        isCreator: o._openid === currentUserId,
        _preview: isTomorrow,
        // 不用下单时冻结的 expectText（隔天会显示成"明天"），
        // 按查看时的今明关系现算，明天单加"明天"前缀
        timeText: (isTomorrow ? '明天 ' : '') + this.mealTimeText(o)
      }
    }
    return {
      today: groups.today.map(o => decorate(o, false)),
      tomorrow: groups.tomorrow.map(o => decorate(o, true))
    }
  },

  // 期望时间文案：只显示档位或具体时刻（"明天"前缀由调用方按需添加）
  mealTimeText(o) {
    if (!o.expectTime) return o.expectText || this.formatTime(o.createTime)
    const SLOT_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
    return SLOT_LABEL[o.expectSlot] || o.expectTimeText || this.formatTime(o.expectTime)
  },

  // 小饭桌空状态文案：仅今天无单时展示；今天没点但明天有单时顺带预告明天已安排
  computeTableEmptyText(today, tomorrow) {
    if (today.length > 0) return ''
    if (tomorrow.length > 0) return '今天还没点餐哦~'
    return '小饭桌还空着呢，快去点些爱吃的吧~'
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
    else if (hour < 13) greeting = '中午好'
    else if (hour < 18) greeting = '下午好'
    else greeting = '晚上好'
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

  // 跳转到订单详情（小饭桌今明两天的单共用）
  goToMealOrder(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  // 跳转到绑定页
  goToBind() {
    wx.navigateTo({ url: '/pages/bind/index' })
  },

  // 跳转到点餐记录
  goToOrderRecords() {
    wx.navigateTo({ url: '/pages/order-records/index' })
  },

  // 跳转到分类管理
  goToCategoryManage() {
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/category-manage/index' })
  },

  // 跳转到「我的」页并自动打开编辑资料（tab 页无法 navigateTo 传参，用一次性标记）
  goToSetProfile() {
    app.globalData.pendingEditProfile = true
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
