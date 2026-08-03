// CoupleMeta 公共助手
// 注意：本文件为唯一源文件（cloudfunctions/_shared/couplemeta.js），
// 部署时需复制到各云函数目录，修改后请同步所有副本，保持内容一致。
//
// 功能：coupleId 容器缓存 / CoupleMeta 懒创建 / 版本+1 / 计数维护
//
// CoupleMeta 集合文档结构（_id = coupleId）：
// { _id, dishVer, categoryVer, orderVer, userVer, dishCount, orderCount, updateTime }

const COUPLE_CACHE_TTL = 60 * 1000
// 容器级缓存：openid -> { coupleId, ts }，云函数容器复用期间生效
// 只缓存非空 coupleId，避免绑定后 60s 内读到旧的空值
const coupleCache = new Map()

// 绑定/解绑时清理缓存
function clearCoupleCache(openid) {
  if (openid) coupleCache.delete(openid)
}

// 获取当前用户的 coupleId（命中缓存时省 1 次 User 表查询）
async function getCoupleIdCached(db, openid) {
  const hit = coupleCache.get(openid)
  if (hit && Date.now() - hit.ts < COUPLE_CACHE_TTL) {
    return hit.coupleId
  }
  const res = await db.collection('User').doc(openid).get().catch(() => null)
  const user = res && res.data
  if (!user) return ''
  const coupleId = user.coupleId || ''
  if (coupleId) {
    coupleCache.set(openid, { coupleId, ts: Date.now() })
  }
  return coupleId
}

// 懒创建：存量情侣没有 CoupleMeta 文档时，用真实 count 初始化，版本从 1 开始
async function ensureMeta(db, coupleId) {
  if (!coupleId) return null
  const col = db.collection('CoupleMeta')
  const existing = await col.doc(coupleId).get().catch(() => null)
  if (existing && existing.data) return existing.data

  const [dishRes, orderRes] = await Promise.all([
    db.collection('DishList').where({ coupleId }).count(),
    db.collection('OrderList').where({ coupleId }).count()
  ])
  const meta = {
    _id: coupleId,
    dishVer: 1,
    categoryVer: 1,
    orderVer: 1,
    userVer: 1,
    dishCount: dishRes.total,
    orderCount: orderRes.total,
    updateTime: db.serverDate()
  }
  await col.add({ data: meta }).catch(() => {})
  return Object.assign({}, meta, { updateTime: new Date() })
}

// 版本 +1（可选同步维护计数），返回计算后的最新 meta
// field: dishVer | categoryVer | orderVer | userVer
// countDelta 形如 { dishCount: 1 } / { orderCount: -1 }
async function incVersion(db, coupleId, field, countDelta) {
  if (!coupleId || !field) return null
  const meta = await ensureMeta(db, coupleId)
  if (!meta) return null

  const _ = db.command
  const updateData = { updateTime: db.serverDate() }
  updateData[field] = _.inc(1)
  const newMeta = Object.assign({}, meta, { [field]: (meta[field] || 0) + 1 })
  if (countDelta) {
    for (const key in countDelta) {
      updateData[key] = _.inc(countDelta[key])
      newMeta[key] = (meta[key] || 0) + countDelta[key]
    }
  }
  await db.collection('CoupleMeta').doc(coupleId).update({ data: updateData }).catch(() => {})
  return newMeta
}

module.exports = {
  getCoupleIdCached,
  clearCoupleCache,
  ensureMeta,
  incVersion
}
