Component({
  data: {
    show: false,
    type: '', // 'profile' 或 'bind'
    _mounted: false, // 控制首次挂载动画
    _checking: false // 防止并发检查（attached 与 pageLifetimes.show 可能同时触发）
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
    async _check() {
      // 防重入：避免 attached 和 pageLifetimes.show 同时触发导致并发竞态
      if (this.data._checking) return
      this.setData({ _checking: true })

      try {
        const app = getApp()
        if (!app) return

        // 等待全局用户信息加载完成，避免因异步未完成导致状态误判
        // loadUserInfo 有缓存，已加载时立即返回，不影响性能
        if (typeof app.loadUserInfo === 'function') {
          await app.loadUserInfo()
        }

        if (!app.isProfileComplete()) {
          this.setData({ show: true, type: 'profile' })
        } else if (!app.isBound()) {
          this.setData({ show: true, type: 'bind' })
        } else {
          this.setData({ show: false, type: '' })
        }
      } catch (e) {
        console.error('[bind-guard] check error', e)
      } finally {
        this.setData({ _checking: false })
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
