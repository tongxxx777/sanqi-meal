const app = getApp()
const imageCache = require('../../utils/imageCache.js')

Page({
  data: {
    order: null,
    loading: true,
    isCreator: false, // 当前用户是否是点菜人（创建者）
    isCook: false,    // 当前用户是否是做菜人（非创建者）
    partnerName: '',  // 对方昵称
    dishesExpanded: false // 菜品清单是否展开
  },

  async onLoad(options) {
    if (options.id) {
      // 确保用户信息已加载，避免 isCreator 误判和 getDisplayName 返回"未知"
      await app.loadUserInfo()
      this.loadOrder(options.id)
    }
  },

  async loadOrder(id) {
    // 优先从 store 读取（下单/接单后已同步，0 调用）；未命中再云端单查
    const fromStore = (app.globalData.homeStore.orders || []).find(o => o._id === id)
      || (app.globalData.historyStore.orders || []).find(o => o._id === id)
    if (fromStore) {
      this.renderOrder(fromStore)
      return
    }

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

      this.renderOrder(res.result.data)
    } catch (e) {
      console.error('加载订单失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 渲染订单详情
  renderOrder(rawOrder) {
    const order = Object.assign({}, rawOrder)
    // 菜品图本地持久缓存优先，未命中走 cloud:// 并后台落盘
    order.dishes = (order.dishes || []).map(d => ({
      ...d,
      _localImg: imageCache.resolve(d.imageUrl) || d.imageUrl || ''
    }))
    order.dateText = this.formatDate(order.createTime)
    order.timeText = this.formatTime(order.createTime)
    order.expectText = this.expectDisplayText(order)
    order.creatorName = app.getDisplayName(order._openid)
    // 处理旧数据：如果没有 status 字段，默认为 'waiting'
    if (!order.status) {
      order.status = 'waiting'
    }
    // 判断当前用户身份
    const currentUserId = app.globalData.currentUser?._id
    const isCreator = order._openid === currentUserId
    const isCook = !isCreator
    const partnerName = app.getPartnerName()

    // 每次加载订单默认收起菜品清单（>3 时只显示前 3 个，需手动展开）
    this.setData({ order, loading: false, isCreator, isCook, partnerName, dishesExpanded: false })
  },

  // 期望用餐时间展示文案（与首页今日点菜逻辑同步）：
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

  // 做菜人接单：waiting → pending
  async acceptOrder() {
    const { order } = this.data
    if (!order || order.status !== 'waiting') return

    wx.showLoading({ title: '接单中...', mask: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'updateCoupleData',
        data: {
          collection: app.globalData.collectionOrderList,
          docId: order._id,
          action: 'update',
          data: { status: 'pending' }
        }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.message || '接单失败')
      }

      // 用响应里的新版本号同步本地 store（首页/历史页立即可见）
      app.applyOrderUpdated(order._id, { status: 'pending' }, res.result.ver)
      this.setData({ 'order.status': 'pending' })

      wx.hideLoading()
      wx.showToast({ title: '已接单，开始准备吧！', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('接单失败', e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // 标记为已完成：pending → completed
  async markAsCompleted() {
    wx.showModal({
      title: '确认完成',
      content: '确认将此订单标记为已完成吗？',
      success: async (res) => {
        if (!res.confirm) return

        wx.showLoading({ title: '更新中...', mask: true })

        try {
          const res = await wx.cloud.callFunction({
            name: 'updateCoupleData',
            data: {
              collection: app.globalData.collectionOrderList,
              docId: this.data.order._id,
              action: 'update',
              data: { status: 'completed' }
            }
          })

          if (!res.result?.success) {
            throw new Error(res.result?.message || '更新失败')
          }

          // 用响应里的新版本号同步本地 store（首页/历史页立即可见）
          app.applyOrderUpdated(this.data.order._id, { status: 'completed' }, res.result.ver)
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

      // 上传前压缩，降低存储体积与下载流量
      let uploadPath = tempPath
      try {
        const compressed = await wx.compressImage({ src: tempPath, quality: 80 })
        if (compressed && compressed.tempFilePath) uploadPath = compressed.tempFilePath
      } catch (e) { /* 压缩失败则用原图 */ }

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: uploadPath
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
    const res = await wx.cloud.callFunction({
      name: 'updateCoupleData',
      data: {
        collection: app.globalData.collectionOrderList,
        docId: this.data.order._id,
        action: 'update',
        data: { finishedPhoto: fileID }
      }
    })

    // 用响应里的新版本号同步本地 store
    if (res.result?.success) {
      app.applyOrderUpdated(this.data.order._id, { finishedPhoto: fileID }, res.result.ver)
    }
    // cloud:// 可直接渲染，无需临时链接
    this.setData({ 'order.finishedPhoto': fileID })
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
          // 删除云存储文件（finishedPhoto 保存的即原始 cloud:// fileID）
          const rawId = this.data.order.finishedPhoto
          if (rawId) {
            await wx.cloud.deleteFile({
              fileList: [rawId]
            })
          }

          // 更新订单记录
          const updateRes = await wx.cloud.callFunction({
            name: 'updateCoupleData',
            data: {
              collection: app.globalData.collectionOrderList,
              docId: this.data.order._id,
              action: 'update',
              data: { finishedPhoto: '' }
            }
          })

          // 用响应里的新版本号同步本地 store
          if (updateRes.result?.success) {
            app.applyOrderUpdated(this.data.order._id, { finishedPhoto: '' }, updateRes.result.ver)
          }
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

  // 展开 / 收起菜品清单
  toggleDishes() {
    this.setData({ dishesExpanded: !this.data.dishesExpanded })
  },

  // 分享订单（伴侣视角）：结合期望用餐时间生成标题
  onShareAppMessage() {
    const { order } = this.data
    if (!order) return { title: app.getKitchenName(), path: '/pages/index/index' }
    return {
      title: this.shareTitle(),
      path: `/pages/order-detail/index?id=${order._id}`,
      imageUrl: '/images/default.jpg'
    }
  },

  // 按期望用餐时间生成分享标题（复用 expectDisplayText，兼容新旧数据、当天/次日判定一致）：
  // 档位："午餐点好了" / "明天的晚餐点好了"
  // 时刻："下午2:00的饭点好了" / "明天下午3:00的饭点好了"
  shareTitle() {
    const text = (this.data.order && this.expectDisplayText(this.data.order)) || ''
    if (!text) return '饭点好了，就等你来确认啦💌'
    const isTomorrow = text.startsWith('明天')
    const core = text.replace(/^明天\s*/, '')
    // 档位词保持原词：早餐/午餐/晚餐（不转口语）
    const isSlot = ['早餐', '午餐', '晚餐'].includes(core)
    if (isSlot) {
      // 次日加"的"（"明天的晚餐/点好了"断句清晰，避免"明天/晚餐点/好了"歧义）
      return (isTomorrow ? '明天的' : '') + core + '点好了，就等你来确认啦💌'
    }
    // 自定义时刻："明天"直接修饰时刻，不加"的"
    return (isTomorrow ? '明天' : '') + core + '的饭点好了，就等你来确认啦💌'
  },
})
