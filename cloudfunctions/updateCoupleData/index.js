const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID
  const { collection, docId, docIds, action, data, field, by } = event

  try {
    // 获取当前用户信息
    const userRes = await db.collection('User').doc(currentOpenid).get()
    const currentUser = userRes.data

    if (!currentUser) {
      return { success: false, message: '用户不存在' }
    }

    // 获取当前 coupleId
    const coupleId = currentUser.coupleId

    // 验证文档是否属于当前 coupleId
    if (docId) {
      const docRes = await db.collection(collection).doc(docId).get()
      const doc = docRes.data
      if (doc.coupleId !== coupleId) {
        return { success: false, message: '无权操作' }
      }
    }

    // 执行操作
    let result
    switch (action) {
      case 'update':
        result = await db.collection(collection).doc(docId).update({ data })
        return { success: true, updated: result.stats.updated }

      case 'remove':
        result = await db.collection(collection).doc(docId).remove()
        return { success: true, removed: result.stats.removed }

      case 'inc':
        // 特殊操作：自增字段
        const incData = {}
        for (const key in data) {
          incData[key] = _.inc(data[key])
        }
        result = await db.collection(collection).doc(docId).update({ data: incData })
        return { success: true, updated: result.stats.updated }

      case 'batchInc':
        // 批量自增：对多个菜品统一加 orderCount，一次云函数完成，避免 N 道菜 N 次调用
        if (!docIds || !Array.isArray(docIds) || !docIds.length) {
          return { success: false, message: 'docIds 不能为空' }
        }
        if (!field || !by) {
          return { success: false, message: 'field 和 by 不能为空' }
        }
        // 批量更新（云函数内循环不计入调用次数）
        const batchResult = await Promise.all(
          docIds.map(id =>
            db.collection(collection).doc(id).update({
              data: { [field]: _.inc(by) }
            })
          )
        )
        return { success: true, updated: batchResult.length }

      default:
        return { success: false, message: '不支持的操作' }
    }
  } catch (e) {
    console.error('updateCoupleData error', e)
    return { success: false, message: '操作失败', error: e.message }
  }
}
