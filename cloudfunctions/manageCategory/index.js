const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const couplemeta = require('./couplemeta.js')

// 默认分类（legacyId 用于迁移旧数据）
const DEFAULT_CATEGORIES = [
  { legacyId: 'meat', name: '荤菜', icon: '🥩', sort: 0 },
  { legacyId: 'vegetable', name: '素菜', icon: '🥬', sort: 1 },
  { legacyId: 'soup', name: '汤类', icon: '🍲', sort: 2 },
  { legacyId: 'rice', name: '主食', icon: '🍚', sort: 3 },
  { legacyId: 'noodle', name: '面食', icon: '🍜', sort: 4 },
  { legacyId: 'cold', name: '凉菜', icon: '🥗', sort: 5 },
  { legacyId: 'dessert', name: '甜点', icon: '🍰', sort: 6 },
  { legacyId: 'drink', name: '饮品', icon: '🥤', sort: 7 },
]

// 创建默认分类，并批量迁移旧菜品数据（where().update() 一次调用更新全部匹配文档）
async function initCategories(col, dishCol, coupleId, currentOpenid) {
  for (const cat of DEFAULT_CATEGORIES) {
    const addRes = await col.add({
      data: {
        name: cat.name,
        icon: cat.icon,
        sort: cat.sort,
        coupleId,
        _openid: currentOpenid,
        createTime: db.serverDate()
      }
    })
    // 迁移：把旧 category='meat' 等 legacyId 批量改为新的 _id
    await dishCol.where({ coupleId, category: cat.legacyId })
      .update({ data: { category: addRes._id } })
      .catch(e => console.error('migrate dishes error', cat.legacyId, e))
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID
  const { action, data } = event

  try {
    // 获取当前 coupleId（容器缓存，命中时省 1 次 User 表查询）
    const coupleId = await couplemeta.getCoupleIdCached(db, currentOpenid)
    if (!coupleId) {
      return { success: false, message: '未绑定伴侣' }
    }

    const col = db.collection('Category')
    const dishCol = db.collection('DishList')

    switch (action) {
      case 'list': {
        // 判空自动初始化：前端永远只调 list 一次，不再单独调 init
        const existing = await col.where({ coupleId }).count()
        if (existing.total === 0) {
          await initCategories(col, dishCol, coupleId, currentOpenid)
          await couplemeta.incVersion(db, coupleId, 'categoryVer')
        }
        const res = await col.where({ coupleId }).orderBy('sort', 'asc').limit(50).get()
        const meta = await couplemeta.ensureMeta(db, coupleId)
        return { success: true, data: res.data, categoryVer: meta ? meta.categoryVer : null }
      }

      case 'add': {
        const maxRes = await col.where({ coupleId }).orderBy('sort', 'desc').limit(1).get()
        const maxSort = maxRes.data.length > 0 ? maxRes.data[0].sort + 1 : 0
        const newDoc = {
          name: data.name,
          icon: data.icon,
          sort: maxSort,
          coupleId,
          _openid: currentOpenid,
          createTime: db.serverDate()
        }
        const addRes = await col.add({ data: newDoc })
        const meta = await couplemeta.incVersion(db, coupleId, 'categoryVer')
        // 返回完整新文档与新版本号，前端直接更新本地缓存，无需重拉
        return {
          success: true,
          _id: addRes._id,
          doc: Object.assign({}, newDoc, { _id: addRes._id, createTime: new Date() }),
          categoryVer: meta ? meta.categoryVer : null
        }
      }

      case 'update': {
        const doc = await col.doc(data._id).get()
        if (doc.data.coupleId !== coupleId) {
          return { success: false, message: '无权操作' }
        }
        await col.doc(data._id).update({
          data: { name: data.name, icon: data.icon }
        })
        const meta = await couplemeta.incVersion(db, coupleId, 'categoryVer')
        return { success: true, categoryVer: meta ? meta.categoryVer : null }
      }

      case 'remove': {
        const doc = await col.doc(data._id).get()
        if (doc.data.coupleId !== coupleId) {
          return { success: false, message: '无权操作' }
        }
        // 批量转移菜品到目标分类（一次调用更新全部匹配文档）
        let dishVer = null
        if (data.transferTo) {
          await dishCol.where({ coupleId, category: data._id })
            .update({ data: { category: data.transferTo } })
            .catch(e => console.error('transfer dishes error', e))
          // 菜品的分类发生变化，dishVer +1 让双方菜品缓存按版本失效重拉
          const dishMeta = await couplemeta.incVersion(db, coupleId, 'dishVer')
          dishVer = dishMeta ? dishMeta.dishVer : null
        }
        await col.doc(data._id).remove()
        const meta = await couplemeta.incVersion(db, coupleId, 'categoryVer')
        return { success: true, categoryVer: meta ? meta.categoryVer : null, dishVer }
      }

      case 'reorder': {
        // data.orders = [{ _id, sort }, ...]
        for (const item of data.orders) {
          await col.doc(item._id).update({ data: { sort: item.sort } })
        }
        const meta = await couplemeta.incVersion(db, coupleId, 'categoryVer')
        return { success: true, categoryVer: meta ? meta.categoryVer : null }
      }

      case 'countDishes': {
        // 查询某分类下菜品数量
        const countRes = await dishCol.where({ coupleId, category: data._id }).count()
        return { success: true, count: countRes.total }
      }

      default:
        return { success: false, message: '不支持的操作' }
    }
  } catch (e) {
    console.error('manageCategory error', e)
    return { success: false, message: '操作失败', error: e.message }
  }
}
