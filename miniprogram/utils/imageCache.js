// 云存储图片本地持久缓存
// 策略：命中直接用本地路径（0 次存储调用）；未命中返回 ''（页面用原 cloud:// 照常渲染），
// 同时后台 downloadFile + saveFile 落盘一次，之后永远走本地路径。
// fileID 变化（图片被替换）时映射自动失效，不会有脏数据。

const MAP_KEY = 'v2_image_cache_map'
const MAX_ENTRIES = 300

let cacheMap = null   // { fileID: { path, ts } }
const pending = {}    // fileID -> Promise（防并发重复下载）
const verified = new Set() // 本次启动已验证存在的本地路径

function loadMap() {
  if (cacheMap) return cacheMap
  try {
    cacheMap = wx.getStorageSync(MAP_KEY) || {}
  } catch (e) {
    cacheMap = {}
  }
  return cacheMap
}

function saveMap() {
  try { wx.setStorageSync(MAP_KEY, cacheMap) } catch (e) { /* ignore quota error */ }
}

// 同步解析：命中返回本地路径，未命中返回 '' 并触发后台落盘
function resolve(fileID) {
  if (!fileID || typeof fileID !== 'string' || fileID.indexOf('cloud://') !== 0) {
    return ''
  }
  const map = loadMap()
  const hit = map[fileID]
  if (hit && hit.path) {
    // 校验文件还在（本地缓存可能被系统清理），每次启动只验一次
    if (!verified.has(hit.path)) {
      try {
        wx.getFileSystemManager().accessSync(hit.path)
        verified.add(hit.path)
      } catch (e) {
        delete map[fileID]
        saveMap()
        downloadAndSave(fileID)
        return ''
      }
    }
    hit.ts = Date.now()
    return hit.path
  }
  downloadAndSave(fileID)
  return ''
}

// 后台下载并持久化（每张图一辈子只花 1 次存储下载）
function downloadAndSave(fileID) {
  if (pending[fileID]) return pending[fileID]
  pending[fileID] = (async () => {
    try {
      const res = await wx.cloud.downloadFile({ fileID })
      const fs = wx.getFileSystemManager()
      const savedPath = await new Promise((resolvePromise, rejectPromise) => {
        fs.saveFile({
          tempFilePath: res.tempFilePath,
          success: r => resolvePromise(r.savedFilePath),
          fail: rejectPromise
        })
      })
      const map = loadMap()
      map[fileID] = { path: savedPath, ts: Date.now() }
      verified.add(savedPath)
      evictIfNeeded(fs, map)
      saveMap()
    } catch (e) {
      // 下载/落盘失败（含配额不足）：下次仍走 cloud://，不影响展示
    } finally {
      delete pending[fileID]
    }
  })()
  return pending[fileID]
}

// LRU 淘汰最旧的条目
function evictIfNeeded(fs, map) {
  const keys = Object.keys(map)
  if (keys.length <= MAX_ENTRIES) return
  keys.sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0))
  const removeCount = keys.length - MAX_ENTRIES
  for (let i = 0; i < removeCount; i++) {
    const entry = map[keys[i]]
    if (entry && entry.path) {
      try { fs.unlinkSync(entry.path) } catch (e) { /* ignore */ }
      verified.delete(entry.path)
    }
    delete map[keys[i]]
  }
}

module.exports = { resolve }
