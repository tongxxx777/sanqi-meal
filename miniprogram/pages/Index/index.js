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
    togetherDays: 0,
    isBound: false,
    profileComplete: false,
    subscribeRequested: false,
  },

  // 是否已完成首次加载
  hasLoaded: false,

  onLoad() {
    this.setGreeting()
  },

  async onShow() {
    const showSeq = (this._showSeq || 0) + 1
    this._showSeq = showSeq
    const isFirstLoad = !this.hasLoaded
    // 首次进入显示 loading，之后直接显示页面
    if (isFirstLoad) {
      this.setData({ pageLoading: true })
    }
    await this.loadUserInfo(isFirstLoad)
    if (showSeq !== this._showSeq) return
    app.setKitchenTitle()
    // 每次回到首页静默补一次订阅额度（已勾"总是保持"的用户不弹窗）
    app.rearmSubscribe()
    if (isFirstLoad) {
      this.hasLoaded = true
    }
    this.loadHomeData()
    this.refreshUserInfoInBackground(showSeq)
  },

  // 加载用户信息
  // isFirstLoad: 首次加载时，将 pageLoading 合并到同一次 setData 中，减少渲染次数
  async loadUserInfo(isFirstLoad = false) {
    const { currentUser, partner } = await app.loadUserInfo()
    const isBound = app.isBound()
    const profileComplete = app.isProfileComplete()

    // 计算绑定天数
    let bindDays = 0
    if (isBound && currentUser?.bindTime) {
      const bindTime = new Date(currentUser.bindTime)
      const now = new Date()
      bindDays = Math.floor((now - bindTime) / (1000 * 60 * 60 * 24)) + 1
    }

    // 从数据库读取订阅状态
    const subscribeRequested = currentUser?.subscribeStatus === 'subscribed'

    this.setData({
      pageLoading: isFirstLoad ? false : this.data.pageLoading,
      userName: currentUser?.nickname || '',
      userAvatar: currentUser?.avatarUrl || '',
      partnerName: partner?.nickname || '',
      partnerAvatar: partner?.avatarUrl || '',
      bindDays,
      isBound,
      profileComplete,
      subscribeRequested
    })

    if (!isBound) {
      this.setData({
        todayOrders: [],
        dishCount: 0,
        orderCount: 0,
        togetherDays: 0
      })
    }
  },

  async refreshUserInfoInBackground(showSeq) {
    try {
      await app.loadUserInfo(true)
      if (showSeq !== this._showSeq) return
      await this.loadUserInfo()
      app.setKitchenTitle()
      this.loadHomeData()
    } catch (e) {
      console.error('refresh user info error', e)
    }
  },

  async loadHomeData() {
    if (!app.isBound()) return
    await Promise.all([
      this.loadTodayOrder(),
      this.loadStats()
    ])
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

  // 加载今日点菜（按“期望用餐日”聚合，支持一天多条）
  async loadTodayOrder() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionOrderList,
          // 拉最近 30 天创建的订单，覆盖“提前几天下单、今天食用”的情况
          sinceDays: 30,
          orderBy: 'createTime',
          order: 'desc',
          limit: 100
        }
      })

      if (res.result?.success && res.result.data?.length > 0) {
        const now = new Date()
        const currentUserId = app.globalData.currentUser?._id
        const list = res.result.data
          // 计算有效用餐时间：优先期望时间，老数据兜底用创建时间
          .map(o => ({ ...o, _eff: o.expectTime ? new Date(o.expectTime) : new Date(o.createTime) }))
          // 只保留“今天食用”的
          .filter(o => this.isSameDay(o._eff, now))
          // 按用餐时间从早到晚排
          .sort((a, b) => a._eff - b._eff)
          .map(o => {
            if (!o.status) o.status = 'pending'
            return {
              ...o,
              creatorName: app.getDisplayName(o._openid),
              isCreator: o._openid === currentUserId,
              // 有期望时间就展示期望文案，否则展示下单时刻
              timeText: o.expectText || this.formatTime(o.createTime)
            }
          })
        this.setData({ todayOrders: list })
      } else {
        this.setData({ todayOrders: [] })
      }
    } catch (e) {
      console.error('load today order error', e)
    }
  },

  // 判断两个日期是否同一天
  isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear()
      && d1.getMonth() === d2.getMonth()
      && d1.getDate() === d2.getDate()
  },

  // 加载统计数据
  async loadStats() {
    try {
      const [dishRes, orderRes] = await Promise.all([
        wx.cloud.callFunction({
          name: 'getCoupleData',
          data: { collection: app.globalData.collectionDishList, countOnly: true }
        }),
        wx.cloud.callFunction({
          name: 'getCoupleData',
          data: { collection: app.globalData.collectionOrderList, countOnly: true }
        })
      ])

      this.setData({
        dishCount: dishRes.result?.total || 0,
        orderCount: orderRes.result?.total || 0,
        togetherDays: (orderRes.result?.total || 0) > 0 ? Math.max(1, orderRes.result.total) : 0
      })
    } catch (e) {
      console.error('load stats error', e)
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


  // 首页提醒卡片 - 订阅一次性订阅消息
  goToSubscribe() {
    wx.showLoading({ title: '开启中...', mask: true })
    app.bufferSubscribe().then((added) => {
      wx.hideLoading()
      if (added > 0) {
        wx.showToast({ title: '已开启', icon: 'success' })
        this.setData({ subscribeRequested: true })
      } else {
        wx.showToast({ title: '未获得授权，请重试', icon: 'none' })
      }
    }).catch((err) => {
      wx.hideLoading()
      console.error('subscribe error', err)
      wx.showToast({ title: '请先申请消息模板', icon: 'none' })
    })
  },

  // 跳转到点菜页
  goToOrder() {
    app.rearmSubscribe()
    wx.switchTab({ url: '/pages/order/index' })
  },

  // 跳转到今日订单详情
  goToTodayOrder(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    app.rearmSubscribe()
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
  },

  // 跳转到最近点菜记录
  async goToRecentOrder() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionOrderList,
          orderBy: 'createTime',
          order: 'desc',
          limit: 1
        }
      })
      if (res.result?.success && res.result.data?.length > 0) {
        const order = res.result.data[0]
        wx.navigateTo({ url: `/pages/order-detail/index?id=${order._id}` })
      } else {
        wx.switchTab({ url: '/pages/order-history/index' })
      }
    } catch (e) {
      console.error('goToRecentOrder error', e)
      wx.switchTab({ url: '/pages/order-history/index' })
    }
  },

  // 跳转到绑定页
  goToBind() {
    wx.navigateTo({ url: '/pages/bind/index' })
  },

  // 跳转到设置页
  goToSettings() {
    wx.navigateTo({ url: '/pages/settings/index' })
  },

  // 跳转到类目管理
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
      title: isBound ? `和${partnerName}的专属小厨房 · ${app.getKitchenName()}` : '叁柒食 · 和TA的专属小厨房',
      path: '/pages/index/index',
      imageUrl: '/images/default.jpg'
    }
  },

  // 分享到朋友圈
  onShareTimeline() {
    const app = getApp()
    return {
      title: app.getKitchenName() + ' · 叁柒食',
      query: '',
      imageUrl: '/images/default.jpg'
    }
  },
})
