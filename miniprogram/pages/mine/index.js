const app = getApp()

Page({
  data: {
    appName: '',
    userName: '',
    userAvatar: '',
    partnerName: '',
    partnerAvatar: '',
    isBound: false,
    showEditModal: false,
    _showSheet: false,   // 控制 DOM 挂载（动画用）
    tempNickname: '',
    tempAvatarUrl: '',
    saving: false,
  },

  async onShow() {
    // 用户信息 + 版本校验（对方改昵称/头像/厨房名时 userVer 变化会精准重拉）
    await app.loadUserInfo()
    await app.syncOnShow('mine')
    this.renderUser()
    this.loadAppInfo()
    app.setKitchenTitle()
    // 一次性标记：tab 页无法 navigateTo 传参，由 switchTab 方写入 globalData
    if (app.globalData.pendingEditProfile) {
      app.globalData.pendingEditProfile = false
      this._autoEditProfile = true
    }
    if (this._autoEditProfile) {
      this._autoEditProfile = false
      this.openEditProfile()
    }
  },

  // 从 globalData 渲染用户信息（唯一数据源）
  renderUser() {
    const { currentUser, partner } = app.globalData
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
    this.setData({ appName: app.getKitchenName() })
  },

  // 跳转到绑定页面
  goToBind() {
    wx.navigateTo({ url: '/pages/bind/index' })
  },

  // 跳转到点餐记录
  goToOrderRecords() {
    wx.navigateTo({ url: '/pages/order-records/index' })
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

    let uploadedFileID = ''
    try {
      let avatarUrl = userAvatar
      // 如果选择了新头像，压缩后上传到云存储
      if (tempAvatarUrl) {
        let uploadPath = tempAvatarUrl
        try {
          const compressed = await wx.compressImage({ src: tempAvatarUrl, quality: 80 })
          if (compressed && compressed.tempFilePath) uploadPath = compressed.tempFilePath
        } catch (e) { /* 压缩失败则用原图 */ }
        const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).substr(2)}.jpg`
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath,
          filePath: uploadPath
        })
        avatarUrl = uploadRes.fileID
        uploadedFileID = uploadRes.fileID
      }

      // 调用云函数更新用户信息（响应直接返回最新 user/partner 与新 userVer）
      const res = await wx.cloud.callFunction({
        name: 'createUser',
        data: { nickname, avatarUrl }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.error || '保存失败')
      }

      // 换头像成功：回收旧头像文件（静默失败不影响用户）
      if (uploadedFileID && userAvatar && userAvatar.indexOf('cloud://') === 0 && userAvatar !== avatarUrl) {
        wx.cloud.deleteFile({ fileList: [userAvatar] }).catch(e => console.error('回收旧头像失败', e))
      }

      // 用响应里的最新数据同步全局（首页等其他页面立即读取到新昵称，无需二次拉取）
      app.applyUserUpdated(res.result.user, res.result.partner, res.result.userVer)
      this.renderUser()
      app.setKitchenTitle()

      wx.hideLoading()
      this._closeSheet()
      wx.showToast({ title: '保存成功', icon: 'success', duration: 1500 })
    } catch (e) {
      wx.hideLoading()
      console.error('save profile error', e)
      // 落库失败：刚上传的新头像成孤儿，回收
      if (uploadedFileID) {
        wx.cloud.deleteFile({ fileList: [uploadedFileID] }).catch(() => {})
      }
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

})
