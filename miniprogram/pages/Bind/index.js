const app = getApp()

Page({
  data: {
    inviteCode: '',
    inputCode: '',
    nickname: '',
    avatarUrl: '',
    partnerNickname: '',
    partnerAvatarUrl: '',
    bindStatus: 'unbound',
    bindDays: 0,
    bindDate: '',
    dishCount: 0,
    orderCount: 0,
    kitchenName: '',
    tempKitchenName: '',
    showKitchenNameModal: false,
    loading: true,
    isSubmitting: false,
  },

  onLoad() {},

  async onShow() {
    await this.loadUserInfo()
  },

  async loadUserInfo() {
    this.setData({ loading: true })
    const { currentUser, partner } = await app.loadUserInfo()

    let bindDays = 0
    let bindDate = ''
    if (currentUser?.bindStatus === 'bound' && currentUser?.bindTime) {
      const bindTime = new Date(currentUser.bindTime)
      const now = new Date()
      bindDays = Math.floor((now - bindTime) / (1000 * 60 * 60 * 24)) + 1
      bindDate = `${bindTime.getFullYear()}年${bindTime.getMonth() + 1}月${bindTime.getDate()}日`
    }

    this.setData({
      loading: false,
      inviteCode: currentUser?.inviteCode || '',
      nickname: currentUser?.nickname || '',
      avatarUrl: currentUser?.avatarUrl || '',
      bindStatus: currentUser?.bindStatus || 'unbound',
      bindDays,
      bindDate,
      kitchenName: app.getKitchenName(),
      partnerNickname: partner?.nickname || '',
      partnerAvatarUrl: partner?.avatarUrl || ''
    })

    if (currentUser?.bindStatus === 'bound') {
      this.loadStats()
    }
  },

  async loadStats() {
    try {
      const { dishCount, orderCount } = await app.getStats()
      this.setData({ dishCount, orderCount })
    } catch (e) {
      console.error('loadStats error', e)
    }
  },

  onInputCode(e) {
    this.setData({ inputCode: e.detail.value.toUpperCase() })
  },

  async bindPartner() {
    const { inputCode, isSubmitting } = this.data
    if (isSubmitting || !inputCode || inputCode.length !== 6) {
      wx.showToast({ title: '请输入6位邀请码', icon: 'none' })
      return
    }

    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '绑定中...', mask: true })

    const result = await app.bindPartner(inputCode)

    if (result.success) {
      wx.hideLoading()
      await app.loadUserInfo(true)
      await this.loadUserInfo()
      wx.showToast({ title: '绑定成功', icon: 'success' })
    } else {
      wx.hideLoading()
      wx.showToast({ title: result.message, icon: 'none' })
    }
    this.setData({ isSubmitting: false })
  },

  unbindPartner() {
    wx.showModal({
      title: '确认解绑',
      content: '解绑后你们将无法互相看到对方的点菜，确定要解绑吗？',
      confirmColor: '#E57373',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '解绑中...', mask: true })
          const result = await app.unbindPartner()
          if (result.success) {
            await this.loadUserInfo()
            wx.hideLoading()
            wx.showToast({ title: '已解绑', icon: 'success' })
          } else {
            wx.hideLoading()
            wx.showToast({ title: result.message, icon: 'none' })
          }
        }
      }
    })
  },

  copyInviteCode() {
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => {
        wx.showToast({ title: '已复制邀请码', icon: 'success' })
      }
    })
  },

  onShareAppMessage() {
    const { inviteCode, nickname } = this.data
    return {
      title: `${nickname || '我'}邀请你一起使用叁柒食`,
      path: `/pages/bind-confirm/index?inviteCode=${inviteCode}`,
      imageUrl: '/images/default.jpg'
    }
  },

  showKitchenNameModal() {
    this.setData({
      showKitchenNameModal: true,
      tempKitchenName: this.data.kitchenName
    })
  },

  hideKitchenNameModal() {
    this.setData({ showKitchenNameModal: false })
  },

  preventClose() {},

  onKitchenNameInput(e) {
    let value = e.detail.value
    if (value.length > 8) value = value.slice(0, 8)
    this.setData({ tempKitchenName: value })
    return value
  },

  async saveKitchenName() {
    const { tempKitchenName } = this.data
    if (!tempKitchenName.trim()) {
      wx.showToast({ title: '请输入厨房名称', icon: 'none' })
      return
    }
    if (tempKitchenName.length > 8) {
      wx.showToast({ title: '名称不能超过8个字', icon: 'none' })
      return
    }

    wx.showLoading({ title: '保存中...' })
    const result = await app.updateKitchenName(tempKitchenName.trim())
    wx.hideLoading()

    if (result.success) {
      this.setData({
        kitchenName: tempKitchenName.trim(),
        showKitchenNameModal: false
      })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } else {
      wx.showToast({ title: result.message, icon: 'none' })
    }
  },
})
