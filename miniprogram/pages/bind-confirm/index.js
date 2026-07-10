const app = getApp()

Page({
  data: {
    inviteCode: '',
    inviterNickname: '',
    inviterAvatarUrl: '',
    loading: true,
    loadFailed: false,
    failMessage: '',
    failCode: '',      // SELF_INVITE / NOT_FOUND / ALREADY_BOUND / PARTNER_BOUND
    submitting: false,
    // 当前用户信息
    avatarUrl: '',
    isBound: false
  },

  onLoad(options) {
    const inviteCode = options.inviteCode || ''
    if (!inviteCode || inviteCode.length !== 6) {
      this.setData({
        loading: false,
        loadFailed: true,
        failMessage: '邀请链接无效，请联系邀请人重新分享',
        failCode: 'INVALID'
      })
      return
    }

    this.setData({ inviteCode: inviteCode.toUpperCase() })
    this.loadCurrentUserAndInviter()
  },

  // 加载当前用户信息和邀请人信息
  async loadCurrentUserAndInviter() {
    try {
      // 先确保当前用户已注册
      await app.loadUserInfo()

      // 并行请求：获取邀请人信息
      const res = await wx.cloud.callFunction({
        name: 'getInviterInfo',
        data: { inviteCode: this.data.inviteCode }
      })

      if (!res.result?.success) {
        this.setData({
          loading: false,
          loadFailed: true,
          failMessage: res.result?.message || '获取邀请信息失败',
          failCode: res.result?.code || ''
        })
        return
      }

      const inviter = res.result.inviter
      const { currentUser } = await app.loadUserInfo()
      const isBound = app.isBound()

      // cloud:// 可直接渲染，无需临时链接
      let inviterAvatarUrl = inviter.avatarUrl || ''

      this.setData({
        loading: false,
        inviterNickname: inviter.nickname || '',
        inviterAvatarUrl,
        avatarUrl: currentUser?.avatarUrl || '',
        isBound
      })
    } catch (e) {
      console.error('loadCurrentUserAndInviter error', e)
      this.setData({
        loading: false,
        loadFailed: true,
        failMessage: '网络异常，请稍后重试',
        failCode: 'NETWORK'
      })
    }
  },

  // 接受邀请
  async acceptInvite() {
    if (this.data.submitting) return
    this.setData({ submitting: true })

    const result = await app.bindPartner(this.data.inviteCode)

    if (result.success) {
      wx.showToast({ title: '绑定成功', icon: 'success' })

      // 绑定成功后跳转到绑定详情页
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/bind/index' })
      }, 800)
    } else {
      wx.showToast({ title: result.message, icon: 'none' })
    }

    this.setData({ submitting: false })
  },

  // 暂不接受 / 返回首页
  declineInvite() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  // 跳转到绑定页面
  goToBindPage() {
    wx.redirectTo({ url: '/pages/bind/index' })
  }
})
