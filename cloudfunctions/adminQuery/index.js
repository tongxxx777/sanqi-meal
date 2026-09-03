const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// ========== 管理员 openid 白名单 ==========
// 【部署前必改】把自己的 openid 填进来（User 表中文档的 _id 即 openid，
// 也可在开发者工具控制台日志中查看）。非白名单用户调用一律拒绝。
const ADMIN_OPENIDS = [
  'onaJz5Q5YUemGamQy4ePlfuCmuFw'
]

// 管理端只读查询：couples / dishes / orders
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID

  // 第一道：白名单校验，任何 action 未过校验直接拒绝
  if (!ADMIN_OPENIDS.includes(currentOpenid)) {
    return { success: false, message: '无权访问' }
  }

  const { action } = event

  try {
    switch (action) {
      case 'couples':
        return await listCouples()
      case 'dishes':
        return await listDishes(event.coupleId)
      case 'orders':
        return await listOrders(event.coupleId, event.skip, event.limit)
      default:
        return { success: false, message: '未知操作' }
    }
  } catch (e) {
    console.error('adminQuery error', action, e)
    return { success: false, message: '查询失败：' + (e.message || e) }
  }
}

// 情侣列表：User 按 coupleId 两两聚合；未绑定用户单列
// 计数混合策略：优先读 CoupleMeta 缓存计数（快），meta 未初始化（对方未冷启动过）才实时 count，
// 避免每对情侣 2 次 count 导致函数超时（-504003）
// 所有情侣都展示（含管理员自己那对，由前端过滤 0 道菜的）
async function listCouples() {
  // field 投影只取必要字段，降低传输量
  const [userRes, metaRes] = await Promise.all([
    db.collection('User').field({ nickname: true, avatarUrl: true, coupleId: true }).limit(1000).get(),
    db.collection('CoupleMeta').field({ dishCount: true, orderCount: true }).limit(1000).get().catch(() => ({ data: [] }))
  ])

  const metaMap = {}
  for (const m of metaRes.data) {
    metaMap[m._id] = m
  }

  const coupleMap = {}
  const unbound = []

  for (const u of userRes.data) {
    const member = {
      openid: u._id,
      nickname: u.nickname || '未设置',
      avatarUrl: u.avatarUrl || ''
    }
    if (u.coupleId) {
      if (!coupleMap[u.coupleId]) coupleMap[u.coupleId] = []
      coupleMap[u.coupleId].push(member)
    } else {
      unbound.push(member)
    }
  }

  const couples = await Promise.all(Object.keys(coupleMap).map(async coupleId => {
    const meta = metaMap[coupleId]
    let dishCount
    let orderCount
    if (meta && typeof meta.dishCount === 'number') {
      // 缓存计数（由写入链路实时维护，可信）
      dishCount = meta.dishCount
      orderCount = meta.orderCount || 0
    } else {
      // meta 未初始化才实时 count，保证不显示 0
      const [dishRes, orderRes] = await Promise.all([
        db.collection('DishList').where({ coupleId }).count(),
        db.collection('OrderList').where({ coupleId }).count()
      ])
      dishCount = dishRes.total
      orderCount = orderRes.total
    }
    return { coupleId, members: coupleMap[coupleId], dishCount, orderCount }
  }))

  // 订单次数多的排前面
  couples.sort((a, b) => b.orderCount - a.orderCount)

  return { success: true, couples, unbound }
}

// 某对情侣的全部菜品（单情侣量级小，一次拉完）
// 按被点次数降序；category 是分类文档 _id，附带翻译成 categoryName 展示
// categories 数组（_id/name/icon，按 sort 升序）供前端分类胶囊与「菜单排序」使用
async function listDishes(coupleId) {
  if (!coupleId) return { success: false, message: '缺少 coupleId' }
  const [dishRes, catRes] = await Promise.all([
    db.collection('DishList')
      .where({ coupleId })
      .orderBy('createTime', 'desc')
      .limit(1000)
      .get(),
    db.collection('Category')
      .where({ coupleId })
      .orderBy('sort', 'asc')
      .limit(100)
      .get()
      .catch(() => ({ data: [] }))
  ])

  const catMap = {}
  const categories = []
  for (const c of catRes.data) {
    catMap[c._id] = (c.icon ? c.icon + ' ' : '') + (c.name || '')
    categories.push({ _id: c._id, name: c.name || '', icon: c.icon || '' })
  }

  const dishes = dishRes.data.map(d => Object.assign({}, d, {
    categoryName: catMap[d.category] || ''
  }))
  // 被点次数多的排上面
  dishes.sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0))

  return { success: true, dishes, categories }
}

// 某对情侣的订单：createTime 倒序 + skip/limit 分页
async function listOrders(coupleId, skip = 0, limit = 20) {
  if (!coupleId) return { success: false, message: '缺少 coupleId' }
  const safeSkip = Math.max(0, skip | 0)
  const safeLimit = Math.min(50, Math.max(1, limit | 0))

  const [countRes, res] = await Promise.all([
    db.collection('OrderList').where({ coupleId }).count(),
    db.collection('OrderList')
      .where({ coupleId })
      .orderBy('createTime', 'desc')
      .skip(safeSkip)
      .limit(safeLimit)
      .get()
  ])

  return {
    success: true,
    orders: res.data,
    hasMore: safeSkip + res.data.length < countRes.total
  }
}
