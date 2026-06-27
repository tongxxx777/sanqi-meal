const app = getApp()

Page({
  data: {
    appName: '',
    userName: '',
    userAvatar: '',
    partnerName: '',
    partnerAvatar: '',
    isBound: false,
    dishCount: 0,
    orderCount: 0,
    showEditModal: false,
    _showSheet: false,   // 控制 DOM 挂载（动画用）
    tempNickname: '',
    tempAvatarUrl: '',
    saving: false,
    notifyEnabled: false, // 订阅消息开关状态
  },

  onLoad(options) {
    if (options.editProfile) {
      this._autoEditProfile = true
    }
  },

  async onShow() {
    await this.loadUserInfo()
    this.loadAppInfo()
    await this.loadStats()
    this.checkNotifyStatus()
    app.setKitchenTitle()
    if (this._autoEditProfile) {
      this._autoEditProfile = false
      this.openEditProfile()
    }
  },

  // 加载用户信息
  async loadUserInfo() {
    const { currentUser, partner } = await app.loadUserInfo()
    this.setData({
      userName: currentUser?.nickname || '未设置',
      userAvatar: currentUser?.avatarUrl || '',
      partnerName: partner?.nickname || '',
      partnerAvatar: partner?.avatarUrl || '',
      isBound: app.isBound()
    })
  },

  // 加载应用信息
  loadAppInfo() {
    this.setData({
      appName: app.getKitchenName()
    })
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
        orderCount: orderRes.result?.total || 0
      })
    } catch (e) {
      console.error('load stats error', e)
    }
  },

  // 跳转到绑定页面
  goToBind() {
    wx.navigateTo({ url: '/pages/bind/index' })
  },

  // 打开编辑个人信息弹窗
  openEditProfile() {
    // 先挂载 DOM（隐藏态）
    this.setData({
      _showSheet: true,
      showEditModal: false,
      tempNickname: this.data.userName === '未设置' ? '' : this.data.userName,
      tempAvatarUrl: ''
    })
    // 下一帧触发入场动画
    setTimeout(() => {
      this.setData({ showEditModal: true })
    }, 50)
  },

  // 关闭编辑弹窗（带动画）
  closeEditModal() {
    if (this.data.saving) return
    this._closeSheet()
  },

  /** 关闭浮层动画 */
  _closeSheet() {
    this.setData({ showEditModal: false })
    // 动画结束后卸载 DOM
    setTimeout(() => {
      this.setData({ _showSheet: false })
    }, 350)
  },

  // 阻止冒泡
  preventClose() {},

  // 选择头像
  onChooseAvatar(e) {
    this.setData({ tempAvatarUrl: e.detail.avatarUrl })
  },

  // 输入昵称
  onNicknameInput(e) {
    this.setData({ tempNickname: e.detail.value })
  },

  // 昵称失去焦点（微信昵称按钮会触发此事件）
  onNicknameBlur(e) {
    if (e.detail.value) {
      this.setData({ tempNickname: e.detail.value })
    }
  },

  // 保存个人信息
  async saveProfile() {
    const { tempNickname, tempAvatarUrl, userAvatar, saving } = this.data
    if (saving) return

    const nickname = tempNickname.trim()
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      let avatarUrl = userAvatar
      // 如果选择了新头像，上传到云存储
      if (tempAvatarUrl) {
        const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).substr(2)}.jpg`
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath,
          filePath: tempAvatarUrl
        })
        avatarUrl = uploadRes.fileID
      }

      // 调用云函数更新用户信息
      await wx.cloud.callFunction({
        name: 'createUser',
        data: { nickname, avatarUrl }
      })

      // 刷新用户信息
      await app.loadUserInfo(true)
      await this.loadUserInfo()

      wx.hideLoading()
      this._closeSheet()
      wx.showToast({ title: '保存成功', icon: 'success', duration: 1500 })
    } catch (e) {
      wx.hideLoading()
      console.error('save profile error', e)
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  // 查询订阅消息开关状态（以数据库为准）
  checkNotifyStatus() {
    const subscribed = app.globalData.currentUser?.subscribeStatus === 'subscribed'
    this.setData({ notifyEnabled: subscribed })
  },

})
