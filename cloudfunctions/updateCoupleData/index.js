const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const couplemeta = require('./couplemeta.js')

// 集合 -> 版本字段
function verFieldOf(collection) {
  if (collection === 'DishList') return 'dishVer'
  if (collection === 'OrderList') return 'orderVer'
  return ''
}

// 集合 -> 计数字段
function countFieldOf(collection) {
  if (collection === 'DishList') return 'dishCount'
  if (collection === 'OrderList') return 'orderCount'
  return ''
}

// 删除云存储文件：失败仅记日志，绝不阻断主流程
async function safeDeleteFiles(fileList, tag) {
  const ids = [...new Set(fileList)].filter(id => typeof id === 'string' && id.startsWith('cloud://'))
  if (!ids.length) return
  try {
    await cloud.deleteFile({ fileList: ids })
  } catch (e) {
    console.error(tag, 'deleteFile error', e)
  }
}

// 从 meta 中提取前端关心的版本字段
function pickVer(collection, meta) {
  if (!meta) return null
  const vf = verFieldOf(collection)
  const cf = countFieldOf(collection)
  if (!vf) return null
  const ver = { [vf]: meta[vf] }
  if (cf) ver[cf] = meta[cf]
  return ver
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID
  const { collection, docId, action, data, updates } = event

  try {
    // 获取当前 coupleId（容器缓存，命中时省 1 次 User 表查询）
    const coupleId = await couplemeta.getCoupleIdCached(db, currentOpenid)
    if (!coupleId) {
      return { success: false, message: '用户不存在或未绑定伴侣' }
    }

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
      case 'add': {
        // 新增文档（菜品/订单通用）：自动注入 coupleId、_openid、createTime
        const addData = Object.assign({}, data, {
          coupleId,
          _openid: currentOpenid,
          createTime: db.serverDate()
        })
        const addRes = await db.collection(collection).add({ data: addData })
        const docRes = await db.collection(collection).doc(addRes._id).get()
        const vf = verFieldOf(collection)
        const cf = countFieldOf(collection)
        const meta = vf ? await couplemeta.incVersion(db, coupleId, vf, cf ? { [cf]: 1 } : null) : null
        // 返回完整新文档与新版本号，前端直接更新本地缓存，无需重拉
        return { success: true, _id: addRes._id, doc: docRes.data, ver: pickVer(collection, meta) }
      }

      case 'submitOrder': {
        // 下单：写订单 + 批量菜品 orderCount+1 + orderVer/orderCount 维护，一次云函数完成
        const orderData = Object.assign({}, data, {
          coupleId,
          _openid: currentOpenid,
          status: (data && data.status) || 'waiting',
          createTime: db.serverDate()
        })
        // expectTime 经 JSON 传输后是字符串，转回 Date
        if (orderData.expectTime) {
          orderData.expectTime = new Date(orderData.expectTime)
        }
        const addRes = await db.collection('OrderList').add({ data: orderData })
        // 批量更新菜品点单次数（where().update() 一次调用更新多条）
        const dishIds = (orderData.dishes || []).map(d => d._id).filter(Boolean)
        if (dishIds.length > 0) {
          await db.collection('DishList')
            .where({ _id: _.in(dishIds), coupleId })
            .update({ data: { orderCount: _.inc(1) } })
            .catch(e => console.error('submitOrder batch inc orderCount error', e))
        }
        const docRes = await db.collection('OrderList').doc(addRes._id).get()
        const meta = await couplemeta.incVersion(db, coupleId, 'orderVer', { orderCount: 1 })
        return { success: true, _id: addRes._id, doc: docRes.data, ver: pickVer('OrderList', meta) }
      }

      case 'removeOrder': {
        // 删单：删订单 + 批量回收菜品 orderCount + orderVer/orderCount 维护，一次云函数完成
        const orderRes = await db.collection('OrderList').doc(docId).get().catch(() => null)
        if (!orderRes || !orderRes.data) {
          return { success: false, message: '订单不存在' }
        }
        const order = orderRes.data
        if (order.coupleId !== coupleId) {
          return { success: false, message: '无权操作' }
        }
        await db.collection('OrderList').doc(docId).remove()
        // 联动删除成品照（dishes[].imageUrl 是菜品图快照，不属于本订单，不能删）
        await safeDeleteFiles([order.finishedPhoto], 'removeOrder')
        // 批量回收菜品点单次数（下单时每道菜 +1，删单时对应 -1）
        const dishIds = (order.dishes || []).map(d => d._id).filter(Boolean)
        if (dishIds.length > 0) {
          await db.collection('DishList')
            .where({ _id: _.in(dishIds), coupleId })
            .update({ data: { orderCount: _.inc(-1) } })
            .catch(e => console.error('removeOrder batch dec orderCount error', e))
        }
        const meta = await couplemeta.incVersion(db, coupleId, 'orderVer', { orderCount: -1 })
        return { success: true, removed: 1, ver: pickVer('OrderList', meta) }
      }

      case 'update': {
        result = await db.collection(collection).doc(docId).update({ data })
        // 编辑菜品时被替换的旧图：逐一校验仍被订单快照引用的不删，更新成功后才清理
        if (collection === 'DishList' && Array.isArray(event.oldFileIds) && event.oldFileIds.length) {
          const keep = new Set([data && data.imageUrl, ...(((data && data.steps) || []).map(s => s && s.imageUrl))])
          const orphanFileIds = []
          for (const id of [...new Set(event.oldFileIds)]) {
            if (typeof id !== 'string' || !id.startsWith('cloud://') || keep.has(id)) continue
            // 查询失败按「仍被引用」处理，宁可不删也不误删
            const ref = await db.collection('OrderList')
              .where({ coupleId, 'dishes.imageUrl': id })
              .count()
              .catch(() => ({ total: 1 }))
            if (ref.total === 0) orphanFileIds.push(id)
          }
          await safeDeleteFiles(orphanFileIds, 'update DishList oldFileIds')
        }
        const vf = verFieldOf(collection)
        const meta = vf ? await couplemeta.incVersion(db, coupleId, vf) : null
        return { success: true, updated: result.stats.updated, ver: pickVer(collection, meta) }
      }

      case 'remove': {
        // 删菜前先收集图片 fileID，并逐一检查是否仍被历史订单快照引用（被引用的绝不能删）
        let orphanFileIds = []
        if (collection === 'DishList') {
          const dishRes = await db.collection(collection).doc(docId).get().catch(() => null)
          const dish = dishRes && dishRes.data
          if (dish) {
            const ids = [dish.imageUrl, ...((dish.steps || []).map(s => s && s.imageUrl))]
              .filter(id => typeof id === 'string' && id.startsWith('cloud://'))
            for (const id of [...new Set(ids)]) {
              // 查询失败按「仍被引用」处理，宁可不删也不误删
              const ref = await db.collection('OrderList')
                .where({ coupleId, 'dishes.imageUrl': id })
                .count()
                .catch(() => ({ total: 1 }))
              if (ref.total === 0) orphanFileIds.push(id)
            }
          }
        }
        result = await db.collection(collection).doc(docId).remove()
        // 数据库删除成功后才清理文件
        await safeDeleteFiles(orphanFileIds, 'remove DishList')
        const vf = verFieldOf(collection)
        const cf = countFieldOf(collection)
        const meta = vf ? await couplemeta.incVersion(db, coupleId, vf, cf ? { [cf]: -1 } : null) : null
        return { success: true, removed: result.stats.removed, ver: pickVer(collection, meta) }
      }

      case 'batchUpdate': {
        // 批量更新（菜品排序专用）：一次云函数更新多条文档 + incVersion 一次
        if (!updates || !Array.isArray(updates) || !updates.length) {
          return { success: false, message: 'updates 不能为空' }
        }
        const ids = updates.map(u => u.docId).filter(Boolean)
        if (ids.length !== updates.length) {
          return { success: false, message: 'updates 含无效 docId' }
        }
        // 归属校验：传入的 docId 必须全部属于当前 coupleId
        const countRes = await db.collection(collection)
          .where({ _id: _.in(ids), coupleId })
          .count()
        if (countRes.total !== ids.length) {
          return { success: false, message: '无权操作或文档不存在' }
        }
        // 循环逐条更新（每条 data 各异，无法用 where().update() 合并）
        let updated = 0
        for (const u of updates) {
          try {
            const r = await db.collection(collection).doc(u.docId).update({ data: u.data })
            updated += (r.stats && r.stats.updated) || 0
          } catch (e) {
            console.error('batchUpdate single error', u.docId, e)
          }
        }
        const vf = verFieldOf(collection)
        const meta = vf ? await couplemeta.incVersion(db, coupleId, vf) : null
        return { success: true, updated, ver: pickVer(collection, meta) }
      }

      default:
        return { success: false, message: '不支持的操作' }
    }
  } catch (e) {
    console.error('updateCoupleData error', e)
    return { success: false, message: '操作失败', error: e.message }
  }
}
