const app = getApp()

// 用料/做法数量上限
const MAX_INGREDIENTS = 20
const MAX_STEPS = 15

Page({
  data: {
    _id: '',
    name: '',
    description: '',
    imageUrl: '',
    tempFilePath: '',
    isEdit: false,
    categories: [],
    categoryIndex: 0,
    saving: false,
    // 用料：key 为 wx:key 稳定标识，不落库
    ingredients: [{ key: 'i_0', name: '', amount: '' }],
    maxIngredients: MAX_INGREDIENTS,
    // 做法步骤：imageUrl 用于展示（本地临时路径或云端 fileID），tempFilePath 存在即本地待上传新图
    steps: [{ key: 's_0', imageUrl: '', tempFilePath: '', desc: '' }],
    maxSteps: MAX_STEPS,
    // 图片搜索结果相关
    showAIModal: false,
    aiImages: [],
    aiImageUrls: [],
    selectedAIIndex: -1,
    generating: false,
  },

  async onLoad(options) {
    // 先同步设置编辑标识，防止 onShow 先触发时读不到
    if (options.id) {
      this.setData({ _id: options.id, isEdit: true })
      wx.setNavigationBarTitle({ title: '编辑菜品' })
    }
    await app.loadCategories()
    this.setData({ categories: app.globalData.categories })
    // 编辑模式下立即加载菜品数据
    if (this.data.isEdit && this.data._id) {
      await this.loadDish()
    }
  },

  // 加载菜品信息（编辑模式）
  async loadDish() {
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
      const categoryIndex = this.data.categories.findIndex(c => c._id === dish.category) || 0
      // 保留原始 fileID 用于保存，cloud:// 可直接用于展示
      let displayUrl = dish.imageUrl || ''
      this._rawImageUrl = dish.imageUrl || ''
      // 回填用料/做法；缺失或为空时给一行空行方便直接填写
      const ingredients = (dish.ingredients || []).map(it => ({
        key: this._nextKey('i'),
        name: it.name || '',
        amount: it.amount || ''
      }))
      const steps = (dish.steps || []).map(s => ({
        key: this._nextKey('s'),
        imageUrl: s.imageUrl || '',
        tempFilePath: '',
        desc: s.desc || ''
      }))
      this.setData({
        name: dish.name,
        description: dish.description || '',
        imageUrl: displayUrl,
        categoryIndex: categoryIndex >= 0 ? categoryIndex : 0,
        ingredients: ingredients.length ? ingredients : [{ key: this._nextKey('i'), name: '', amount: '' }],
        steps: steps.length ? steps : [{ key: this._nextKey('s'), imageUrl: '', tempFilePath: '', desc: '' }]
      })
    } catch (e) {
      console.error('加载菜品失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 输入菜品名称
  onNameInput(e) {
    let value = e.detail.value
    if (value.length > 20) value = value.slice(0, 20)
    this.setData({ name: value })
    return value
  },

  // 输入菜品描述
  onDescInput(e) {
    let value = e.detail.value
    if (value.length > 10) value = value.slice(0, 10)
    this.setData({ description: value })
    return value
  },

  // 选择分类
  onCategoryChange(e) {
    this.setData({ categoryIndex: e.detail.value })
  },

  // 生成用料/步骤行的稳定 key（wx:key 用，避免输入时焦点错乱）
  _nextKey(prefix) {
    this._keySeq = (this._keySeq || 0) + 1
    return `${prefix}_${Date.now()}_${this._keySeq}`
  },

  // ===== 用料 =====
  onIngredientInput(e) {
    const { index, field } = e.currentTarget.dataset
    let value = e.detail.value
    const max = field === 'name' ? 20 : 10
    if (value.length > max) value = value.slice(0, max)
    this.setData({ [`ingredients[${index}].${field}`]: value })
    return value
  },

  addIngredient() {
    const ingredients = this.data.ingredients
    if (ingredients.length >= MAX_INGREDIENTS) return
    this.setData({
      ingredients: ingredients.concat([{ key: this._nextKey('i'), name: '', amount: '' }])
    })
  },

  removeIngredient(e) {
    const index = e.currentTarget.dataset.index
    const ingredients = this.data.ingredients.slice()
    ingredients.splice(index, 1)
    // 删到 0 行时保留一个空行，方便直接填写
    if (!ingredients.length) {
      ingredients.push({ key: this._nextKey('i'), name: '', amount: '' })
    }
    this.setData({ ingredients })
  },

  // ===== 做法步骤 =====
  onStepDescInput(e) {
    const index = e.currentTarget.dataset.index
    let value = e.detail.value
    if (value.length > 200) value = value.slice(0, 200)
    this.setData({ [`steps[${index}].desc`]: value })
    return value
  },

  addStep() {
    const steps = this.data.steps
    if (steps.length >= MAX_STEPS) return
    this.setData({
      steps: steps.concat([{ key: this._nextKey('s'), imageUrl: '', tempFilePath: '', desc: '' }])
    })
  },

  removeStep(e) {
    const index = e.currentTarget.dataset.index
    const steps = this.data.steps.slice()
    steps.splice(index, 1)
    if (!steps.length) {
      steps.push({ key: this._nextKey('s'), imageUrl: '', tempFilePath: '', desc: '' })
    }
    this.setData({ steps })
  },

  // 选择/替换步骤图（每步 1 张，点图位即选图）
  chooseStepImage(e) {
    const index = e.currentTarget.dataset.index
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        this.setData({
          [`steps[${index}].tempFilePath`]: tempFilePath,
          [`steps[${index}].imageUrl`]: tempFilePath
        })
      }
    })
  },

  // 删除步骤图
  removeStepImage(e) {
    const index = e.currentTarget.dataset.index
    this.setData({
      [`steps[${index}].tempFilePath`]: '',
      [`steps[${index}].imageUrl`]: ''
    })
  },

  // 选择图片
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        this.setData({
          tempFilePath,
          imageUrl: tempFilePath
        })
      }
    })
  },

  // 搜索图片（兼容 wxml 中 generateAIImage / regenerateAIImage 两个入口）
  generateAIImage() {
    this.searchImages(false)
  },

  regenerateAIImage() {
    this.searchImages(true)
  },

  // 调用云函数搜索图片；refresh=true 时让云函数随机翻页获取不同结果
  async searchImages(refresh = false) {
    if (!this.data.name.trim()) {
      if (!refresh) wx.showToast({ title: '请先输入菜品名称', icon: 'none' })
      return
    }

    this.setData({
      generating: true,
      showAIModal: refresh ? this.data.showAIModal : true,
      aiImages: [],
      aiImageUrls: [],
      selectedAIIndex: -1
    })

    try {
      const res = await wx.cloud.callFunction({
        name: 'generateAIImage',
        data: { dishName: this.data.name.trim(), refresh }
      })

      if (!res.result?.success) {
        wx.showToast({ title: res.result?.message || '图片搜索失败，请重试', icon: 'none' })
        this.setData({ generating: false, showAIModal: false })
        return
      }

      const images = res.result.data.images
      this.setData({
        aiImages: images,
        aiImageUrls: images.map(img => img.url),
        generating: false
      })
    } catch (error) {
      console.error('搜索图片失败', error)
      const errMsg = String(error)
      if (!refresh && (errMsg.includes('TIME_LIMIT_EXCEEDED') || errMsg.includes('-504003'))) {
        wx.showToast({ title: '图片搜索超时，请稍后重试', icon: 'none', duration: 3000 })
      } else {
        wx.showToast({ title: '图片搜索失败，请手动上传', icon: 'none' })
      }
      this.setData({ generating: false, showAIModal: false })
    }
  },

  // 上传图片到云存储（上传前压缩，降低存储体积与下载流量）
  async uploadImage() {
    if (!this.data.tempFilePath) return ''
    return this._uploadToCloud(this.data.tempFilePath)
  },

  // 通用上传：本地临时路径 -> 云端 fileID（主图与步骤图共用）
  async _uploadToCloud(tempFilePath) {
    const cloudPath = `dishes/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`

    try {
      let uploadPath = tempFilePath
      try {
        const compressed = await wx.compressImage({ src: tempFilePath, quality: 80 })
        if (compressed && compressed.tempFilePath) uploadPath = compressed.tempFilePath
      } catch (e) { /* 压缩失败则用原图 */ }
      const res = await wx.cloud.uploadFile({
        cloudPath,
        filePath: uploadPath
      })
      return res.fileID
    } catch (e) {
      console.error('上传图片失败', e)
      throw new Error('图片上传失败')
    }
  },

  // 保存菜品
  async saveDish() {
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }

    const { name, saving, isEdit, _id } = this.data

    if (saving) return

    if (!name.trim()) {
      wx.showToast({ title: '请输入菜品名称', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...' })

    try {
      let imageUrl = this._rawImageUrl || this.data.imageUrl

      // 如果有新选择的本地图片，上传新图片（远程URL已在云存储中，无需重复上传）
      if (this.data.tempFilePath && !this.data.tempFilePath.startsWith('http')) {
        imageUrl = await this.uploadImage()
      }

      // 降级：无任何图片时，使用默认菜品图片
      if (!imageUrl) {
        imageUrl = '/images/default.jpg'
      }

      // 清洗用料：去掉食材名和用量都空的行
      const ingredients = this.data.ingredients
        .map(it => ({ name: (it.name || '').trim(), amount: (it.amount || '').trim() }))
        .filter(it => it.name || it.amount)

      // 清洗步骤：去掉说明和图片都空的步
      const cleanedSteps = this.data.steps
        .map(s => ({ imageUrl: s.imageUrl || '', tempFilePath: s.tempFilePath || '', desc: (s.desc || '').trim() }))
        .filter(s => s.desc || s.imageUrl)

      // 顺序上传本地步骤图（tempFilePath 存在即待上传新图；任一失败中止保存）
      const pendingUploads = cleanedSteps.filter(s => s.tempFilePath)
      for (let i = 0; i < pendingUploads.length; i++) {
        wx.showLoading({ title: `上传步骤图 ${i + 1}/${pendingUploads.length}` })
        pendingUploads[i].imageUrl = await this._uploadToCloud(pendingUploads[i].tempFilePath)
        pendingUploads[i].tempFilePath = ''
      }
      const steps = cleanedSteps.map(s => ({ imageUrl: s.imageUrl, desc: s.desc }))
      wx.showLoading({ title: '保存中...' })

      const category = this.data.categories[this.data.categoryIndex]._id

      if (isEdit) {
        // 编辑模式：更新现有记录
        const res = await wx.cloud.callFunction({
          name: 'updateCoupleData',
          data: {
            collection: app.globalData.collectionDishList,
            docId: _id,
            action: 'update',
            data: {
              name: name.trim(),
              description: this.data.description.trim(),
              imageUrl,
              category,
              ingredients,
              steps,
              updateTime: new Date(),
            }
          }
        })

        wx.hideLoading()

        if (!res.result?.success) {
          wx.showToast({ title: res.result?.message || '修改失败', icon: 'none' })
          return
        }

        // 用响应里的新版本号同步本地 store（菜品库/点餐页立即可见，无需重拉）
        const oldDish = (app.globalData.dishStore.dishes || []).find(d => d._id === _id) || {}
        app.applyDishUpdated(Object.assign({}, oldDish, {
          _id,
          name: name.trim(),
          description: this.data.description.trim(),
          imageUrl,
          category,
          ingredients,
          steps,
          updateTime: new Date(),
        }), res.result.ver)

        wx.showToast({ title: '修改成功', icon: 'success' })
      } else {
        // 新增模式：云函数写入并返回完整新文档与新版本号
        const res = await wx.cloud.callFunction({
          name: 'updateCoupleData',
          data: {
            collection: app.globalData.collectionDishList,
            action: 'add',
            data: {
              name: name.trim(),
              description: this.data.description.trim(),
              imageUrl,
              category,
              ingredients,
              steps,
            }
          }
        })

        wx.hideLoading()

        if (!res.result?.success) {
          wx.showToast({ title: res.result?.message || '添加失败', icon: 'none' })
          this.setData({ saving: false })
          return
        }

        // 用响应里的完整新文档同步本地 store（菜品库/点餐页立即可见，无需重拉）
        app.applyDishAdded(res.result.doc, res.result.ver)
        wx.showToast({ title: '添加成功', icon: 'success' })
      }

      setTimeout(() => {
        wx.navigateBack()
      }, 1500)

    } catch (e) {
      console.error('保存失败', e)
      wx.hideLoading()
      wx.showToast({ title: '保存失败', icon: 'none' })
      this.setData({ saving: false })
    }
  },

  // 预览图片
  onPreviewImage() {
    if (this.data.imageUrl) {
      wx.previewImage({
        current: this.data.imageUrl,
        urls: [this.data.imageUrl]
      })
    }
  },

  // 确认选择图片（已选中的再点击=全屏预览）
  selectAIImage(e) {
    const index = e.currentTarget.dataset.index
    if (this.data.selectedAIIndex === index) {
      // 已选中，全屏预览
      const url = this.data.aiImageUrls[index]
      if (url) {
        wx.previewImage({ current: url, urls: this.data.aiImageUrls })
      }
      return
    }
    this.setData({ selectedAIIndex: index })
  },

  // 确认选择图片（选中后才上传到云存储，避免堆垃圾）
  async confirmAIImage() {
    if (this.data.selectedAIIndex === -1) {
      wx.showToast({ title: '请先选择一张图片', icon: 'none' })
      return
    }

    const selected = this.data.aiImages[this.data.selectedAIIndex]
    if (!selected || !selected.url) return

    // 已选中的再点击=全屏预览；避免双击误触
    if (this._confirming) return
    this._confirming = true

    wx.showLoading({ title: '上传中...', mask: true })

    try {
      // 调用云函数下载百度图片并上传到云存储（dishes/ 目录）
      const res = await wx.cloud.callFunction({
        name: 'generateAIImage',
        data: { action: 'upload', imageUrl: selected.url }
      })

      const result = res.result || {}
      if (!result.success || !result.data || !result.data.fileID) {
        throw new Error(result.message || '上传失败')
      }

      // 保存原始 fileID，saveDish 时直接用，不再二次上传
      this._rawImageUrl = result.data.fileID
      this.setData({
        tempFilePath: '',
        imageUrl: result.data.tempFileURL || result.data.fileID,
        showAIModal: false
      })

      wx.hideLoading()
      wx.showToast({ title: '图片已选择', icon: 'success' })
    } catch (e) {
      console.error('确认AI图片失败', e)
      wx.hideLoading()
      wx.showToast({ title: e.message || '上传失败', icon: 'none' })
    } finally {
      this._confirming = false
    }
  },

  // 关闭图片选择模态框
  closeAIModal() {
    this.setData({
      showAIModal: false,
      generating: false,
      aiImages: [],
      aiImageUrls: [],
      selectedAIIndex: -1
    })
  },

  // 阻止事件冒泡
  preventBubble() {
    // 阻止点击模态框内容区域时关闭模态框
  },

  // 重置表单
  resetForm() {
    this.setData({
      name: '',
      description: '',
      imageUrl: '',
      tempFilePath: '',
      categoryIndex: 0,
      ingredients: [{ key: this._nextKey('i'), name: '', amount: '' }],
      steps: [{ key: this._nextKey('s'), imageUrl: '', tempFilePath: '', desc: '' }],
      showAIModal: false,
      aiImages: [],
      aiImageUrls: [],
      selectedAIIndex: -1,
      generating: false,
    })
  },
})
