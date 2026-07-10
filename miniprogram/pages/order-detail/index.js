const app = getApp()

Page({
  data: {
    order: null,
    loading: true,
    isCreator: false  // 当前用户是否是点菜人（创建者）
  },

  async onLoad(options) {
    if (options.id) {
      // 确保用户信息已加载，避免 isCreator 误判和 getDisplayName 返回"未知"
      await app.loadUserInfo()
      this.loadOrder(options.id)
    }
  },

  // 点开订单（含点开通知）时补一次订阅额度
  onShow() {
    app.rearmSubscribe()
  },


  async loadOrder(id) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionOrderList,
          docId: id
        }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.message || '加载失败')
      }

      const order = res.result.data
      order.dateText = this.formatDate(order.createTime)
      order.timeText = this.formatTime(order.createTime)
      order.expectText = order.expectText || ''
      // 处理旧数据：如果没有 status 字段，默认为 'pending'
      if (!order.status) {
        order.status = 'pending'
      }

      // 批量收集所有需要转换的 cloud:// fileID（菜品图片 + 成品照片）
      // 合并为一次批量请求，替代原来 convertFileURLs + getTempFileURLs 的两次串行 await
      const allFileIds = []
      for (const dish of (order.dishes || [])) {
        if (dish.imageUrl && dish.imageUrl.startsWith('cloud://')) {
          allFileIds.push(dish.imageUrl)
        }
      }
      if (order.finishedPhoto && order.finishedPhoto.startsWith('cloud://')) {
        order._rawFinishedPhoto = order.finishedPhoto
        allFileIds.push(order.finishedPhoto)
      }

      if (allFileIds.length > 0) {
        const urlMap = await app.getTempFileURLs(allFileIds)
        for (const dish of (order.dishes || [])) {
          if (dish.imageUrl && urlMap[dish.imageUrl]) {
            dish._raw_imageUrl = dish.imageUrl
            dish.imageUrl = urlMap[dish.imageUrl]
          }
        }
        if (order._rawFinishedPhoto && urlMap[order._rawFinishedPhoto]) {
          order.finishedPhoto = urlMap[order._rawFinishedPhoto]
        }
      }

      // 此时 currentUser 已在 onLoad 中确保加载完成
      order.creatorName = app.getDisplayName(order._openid)
      // 判断当前用户是否是点菜人（创建者）
      const currentUserId = app.globalData.currentUser?._id
      const isCreator = order._openid === currentUserId
      
      this.setData({ order, loading: false, isCreator })
    } catch (e) {
      console.error('加载订单失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  getCreatorName(openid) {
    return app.getDisplayName(openid)
  },

  formatDate(date) {
    if (!date) return ''
    const d = new Date(date)
    const year = d.getFullYear()
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    return `${year}年${month}月${day}日`
  },

  formatTime(date) {
    if (!date) return ''
    const d = new Date(date)
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  },

  // 标记为已完成
  async markAsCompleted() {
    wx.showModal({
      title: '确认完成',
      content: '确认将此订单标记为已完成吗？',
      success: async (res) => {
        if (!res.confirm) return

        wx.showLoading({ title: '更新中...', mask: true })

        try {
          await wx.cloud.callFunction({
            name: 'updateCoupleData',
            data: {
              collection: app.globalData.collectionOrderList,
              docId: this.data.order._id,
              action: 'update',
              data: { status: 'completed' }
            }
          })

          this.setData({ 'order.status': 'completed' })

          wx.hideLoading()
          wx.showToast({ title: '已完成', icon: 'success' })
        } catch (e) {
          wx.hideLoading()
          console.error('更新订单状态失败', e)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  // 上传成品照片
  async uploadPhoto() {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      })

      if (!res.tempFiles || res.tempFiles.length === 0) return

      wx.showLoading({ title: '上传中...', mask: true })

      const tempPath = res.tempFiles[0].tempFilePath
      const cloudPath = `finished_photos/${this.data.order._id}_${Date.now()}.jpg`

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: tempPath
      })

      await this.saveFinishedPhoto(uploadRes.fileID)

      wx.hideLoading()
      wx.showToast({ title: '上传成功', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      if (e.errMsg && e.errMsg.includes('cancel')) return
      console.error('上传照片失败', e)
      wx.showToast({ title: '上传失败', icon: 'none' })
    }
  },

  // 保存照片到订单记录
  async saveFinishedPhoto(fileID) {
    await wx.cloud.callFunction({
      name: 'updateCoupleData',
      data: {
        collection: app.globalData.collectionOrderList,
        docId: this.data.order._id,
        action: 'update',
        data: { finishedPhoto: fileID }
      }
    })

    const urlMap = await app.getTempFileURLs([fileID])
    this.setData({ 'order.finishedPhoto': urlMap[fileID] || fileID })
  },

  // 预览照片
  previewPhoto() {
    if (!this.data.order.finishedPhoto) return
    wx.previewImage({
      urls: [this.data.order.finishedPhoto],
      current: this.data.order.finishedPhoto
    })
  },

  // 更换照片
  changePhoto() {
    this.uploadPhoto()
  },

  // 删除照片
  deletePhoto() {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这张成品照片吗？',
      success: async (res) => {
        if (!res.confirm) return

        wx.showLoading({ title: '删除中...', mask: true })

        try {
          // 删除云存储文件（使用原始 fileID）
          const rawId = this.data.order._rawFinishedPhoto || this.data.order.finishedPhoto
          if (rawId) {
            await wx.cloud.deleteFile({
              fileList: [rawId]
            })
          }

          // 更新订单记录
          await wx.cloud.callFunction({
            name: 'updateCoupleData',
            data: {
              collection: app.globalData.collectionOrderList,
              docId: this.data.order._id,
              action: 'update',
              data: { finishedPhoto: '' }
            }
          })

          this.setData({ 'order.finishedPhoto': '' })

          wx.hideLoading()
          wx.showToast({ title: '已删除', icon: 'success' })
        } catch (e) {
          wx.hideLoading()
          console.error('删除照片失败', e)
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  // 分享订单
  onShareAppMessage() {
    const { order } = this.data
    if (!order) return { title: '叁柒食', path: '/pages/index/index' }
    const dishNames = (order.dishes || []).map(d => d.name).join('、')
    return {
      title: `${order.creatorName}点了：${dishNames}`,
      path: `/pages/order-detail/index?id=${order._id}`,
      imageUrl: '/images/default.jpg'
    }
  },
})
