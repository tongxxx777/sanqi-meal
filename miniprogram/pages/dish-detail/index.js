const app = getApp()
const imageCache = require('../../utils/imageCache.js')

Page({
  data: {
    _id: '',
    dish: null,
    previewImageUrl: '',
    creatorName: '',
    categoryInfo: null,
    ingredientsView: [],
    stepsView: [],
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
    await app.loadUserInfo()
    await app.loadCategories()
    await this.loadDish()
  },

  // 加载菜品详情（优先读共享 store，写操作后已同步；未命中再云端单查）
  async loadDish() {
    if (!this.data._id) return

    const cached = (app.globalData.dishStore.dishes || []).find(d => d._id === this.data._id)
    if (cached) {
      this.renderDish(cached)
      return
    }

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

      this.renderDish(res.result.data)
    } catch (e) {
      console.error('加载菜品失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 渲染菜品详情
  renderDish(dish) {
    // 本地持久缓存优先，未命中走 cloud:// 并后台落盘
    dish._localImg = imageCache.resolve(dish.imageUrl) || dish.imageUrl || ''
    const categoryInfo = (app.globalData.categories || []).find(c => c._id === dish.category) || null
    // 用料/做法展示数据：清洗空行，步骤图逐项走本地缓存
    const ingredientsView = (dish.ingredients || []).filter(it => it.name || it.amount)
    const stepsView = (dish.steps || [])
      .filter(s => s.desc || s.imageUrl)
      .map(s => ({
        imageUrl: s.imageUrl || '',
        desc: s.desc || '',
        _localImg: s.imageUrl ? (imageCache.resolve(s.imageUrl) || s.imageUrl) : ''
      }))
    this.setData({
      dish,
      categoryInfo,
      ingredientsView,
      stepsView,
      dateMiniText: this.formatDateMini(dish.createTime),
      creatorName: this.getCreatorName(dish._openid)
    })

    wx.setNavigationBarTitle({ title: dish.name })
  },

  // 放大预览步骤图（可在所有步骤图间左右滑动）
  previewStepImage(e) {
    const index = e.currentTarget.dataset.index
    const urls = this.data.stepsView.map(s => s._localImg).filter(Boolean)
    const current = this.data.stepsView[index]?._localImg
    if (current) {
      wx.previewImage({ current, urls })
    }
  },

  // 获取创建者名字
  getCreatorName(openid) {
    return app.getDisplayName(openid)
  },

  // 格式化迷你日期（数据档案格展示：M月D日）
  formatDateMini(date) {
    if (!date) return ''
    const d = new Date(date)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  },

  // 放大预览菜品照片
  previewImage() {
    const url = this.data.dish?._localImg || this.data.dish?.imageUrl || this.data.previewImageUrl
    if (url) {
      wx.previewImage({ urls: [url] })
    }
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

            // 用响应里的新版本号同步本地 store（菜品库/点餐页立即可见，无需重拉）
            app.applyDishRemoved(this.data._id, result.result.ver)

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

})
