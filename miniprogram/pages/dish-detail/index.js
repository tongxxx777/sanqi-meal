const app = getApp()

Page({
  data: {
    _id: '',
    dish: null,
    previewImageUrl: '',
    dateText: '',
    creatorName: '',
    openid: '',
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ _id: options.id })
    }
    if (options.imageUrl) {
      this.setData({ previewImageUrl: decodeURIComponent(options.imageUrl) })
    }
  },

  async onShow() {
    // 确保用户信息已加载，避免 getDisplayName 返回"未知"
    // 同时复用 currentUser._id 作为 openid，省去一次云函数调用
    const { currentUser } = await app.loadUserInfo()
    if (currentUser?._id) {
      this.setData({ openid: currentUser._id })
    }
    await this.loadDish()
  },

  // 加载菜品详情
  async loadDish() {
    if (!this.data._id) return

    try {
      const res = await wx.cloud.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          docId: this.data._id
        }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.message || '加载失败')
      }

      const dish = res.result.data
      this.setData({
        dish,
        dateText: this.formatDate(dish.createTime),
        creatorName: this.getCreatorName(dish._openid)
      })

      wx.setNavigationBarTitle({ title: dish.name })
    } catch (e) {
      console.error('加载菜品失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
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
    const year = d.getFullYear()
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${year}年${month}月${day}日 ${hours}:${minutes}`
  },

  // 编辑菜品
  editDish() {
    wx.navigateTo({
      url: `/pages/dish-add/index?id=${this.data._id}`
    })
  },

  // 删除菜品
  deleteDish() {
    wx.showModal({
      title: '确认删除',
      content: `确定要删除「${this.data.dish.name}」吗？`,
      confirmColor: '#E57373',
      success: async (res) => {
        if (res.confirm) {
          try {
            const result = await wx.cloud.callFunction({
              name: 'updateCoupleData',
              data: {
                collection: app.globalData.collectionDishList,
                docId: this.data._id,
                action: 'remove'
              }
            })

            if (!result.result?.success) {
              throw new Error(result.result?.message || '删除失败')
            }

            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => {
              wx.navigateBack()
            }, 1500)
          } catch (e) {
            console.error('删除失败', e)
            wx.showToast({ title: '删除失败', icon: 'none' })
          }
        }
      }
    })
  },

  // 分享菜品给好友
  onShareAppMessage() {
    const { dish, _id } = this.data
    const name = dish?.name || '这道菜'
    const imageUrl = dish?.imageUrl || '/images/default.jpg'
    return {
      title: `来尝尝「${name}」吧`,
      path: `/pages/dish-detail/index?id=${_id}`,
      imageUrl
    }
  },
})
