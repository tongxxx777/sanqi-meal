Component({
  data: {
    show: false,
    type: '', // 'profile' 或 'bind'
    _mounted: false // 控制首次挂载动画
  },

  lifetimes: {
    attached() {
      // 先挂载 DOM（此时 show=false，渲染为 hidden 态）
      this.setData({ _mounted: true })
      // 下一帧执行检测，触发入场过渡动画
      setTimeout(() => {
        this._check()
      }, 50)
    }
  },

  pageLifetimes: {
    show() {
      this._check()
    }
  },

  methods: {
    _check() {
      const app = getApp()
      if (!app) return
      if (!app.isProfileComplete()) {
        this.setData({ show: true, type: 'profile' })
      } else if (!app.isBound()) {
        this.setData({ show: true, type: 'bind' })
      } else {
        this.setData({ show: false, type: '' })
      }
    },

    /** 关闭横幅 */
    closeBanner() {
      this.setData({ show: false })
      // 200ms 后真正隐藏，让退出动画播完
      setTimeout(() => {
        this.setData({ type: '' })
      }, 350)
    },

    goToBind() {
      wx.navigateTo({ url: '/pages/bind/index' })
    },

    goToSetProfile() {
      wx.navigateTo({ url: '/pages/settings/index?editProfile=true' })
    }
  }
})
