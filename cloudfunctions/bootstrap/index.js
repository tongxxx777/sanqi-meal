// 云函数入口文件 - 冷启动聚合接口
// 一次调用返回：user + partner + CoupleMeta（懒创建）+ 分类（自动初始化）+ 今日订单原始数据
// 冷启动从原来的 6~7 次云函数调用合并为 1 次
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const couplemeta = require('./couplemeta.js')

// 默认分类（与 manageCategory 保持一致，legacyId 用于迁移旧数据）
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

// 生成6位随机邀请码
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

// 创建默认分类，并批量迁移旧菜品数据（与 manageCategory 保持一致）
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
    await dishCol.where({ coupleId, category: cat.legacyId })
      .update({ data: { category: addRes._id } })
      .catch(e => console.error('migrate dishes error', cat.legacyId, e))
  }
}

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  try {
    // 1. 查询/创建用户
    let userRes = await db.collection('User').doc(openid).get().catch(() => null)

    if (!userRes || !userRes.data) {
      // 新用户：生成唯一邀请码并创建
      let inviteCode = generateInviteCode()
      let codeExists = true
      let attempts = 0
      while (codeExists && attempts < 10) {
        const existingCode = await db.collection('User')
          .where({ inviteCode })
          .count()
        if (existingCode.total === 0) {
          codeExists = false
        } else {
          inviteCode = generateInviteCode()
          attempts++
        }
      }

      const newUser = {
        _id: openid,
        nickname: '',
        avatarUrl: '',
        partnerId: '',
        inviteCode,
        bindStatus: 'unbound',
        createTime: db.serverDate()
      }
      await db.collection('User').add({ data: newUser })

      return {
        success: true,
        isNew: true,
        bound: false,
        user: newUser,
        partner: null,
        meta: null,
        categories: [],
        orders: []
      }
    }

    const user = userRes.data

    // 2. 未绑定：只返回用户信息
    if (user.bindStatus !== 'bound' || !user.coupleId) {
      return {
        success: true,
        isNew: false,
        bound: false,
        user,
        partner: null,
        meta: null,
        categories: [],
        orders: []
      }
    }

    const coupleId = user.coupleId

    // 3. 已绑定：并行拉取 partner / CoupleMeta（懒创建）/ 分类（自动初始化）/ 今日订单
    const since = new Date()
    since.setDate(since.getDate() - 30)
    since.setHours(0, 0, 0, 0)

    const catCol = db.collection('Category')
    const catCountRes = await catCol.where({ coupleId }).count()
    if (catCountRes.total === 0) {
      await initCategories(catCol, db.collection('DishList'), coupleId, openid)
      await couplemeta.incVersion(db, coupleId, 'categoryVer')
    }

    const [partnerRes, meta, catRes, orderRes] = await Promise.all([
      db.collection('User').doc(user.partnerId).get().catch(() => null),
      couplemeta.ensureMeta(db, coupleId),
      catCol.where({ coupleId }).orderBy('sort', 'asc').limit(50).get(),
      db.collection('OrderList')
        .where({ coupleId, createTime: _.gte(since) })
        .orderBy('createTime', 'desc')
        .limit(100)
        .get()
        .catch(() => ({ data: [] }))
    ])

    let partner = null
    if (partnerRes && partnerRes.data) {
      partner = {
        openid: partnerRes.data._id,
        nickname: partnerRes.data.nickname,
        avatarUrl: partnerRes.data.avatarUrl
      }
    }

    return {
      success: true,
      isNew: false,
      bound: true,
      user,
      partner,
      meta: meta ? {
        dishVer: meta.dishVer,
        categoryVer: meta.categoryVer,
        orderVer: meta.orderVer,
        userVer: meta.userVer,
        dishCount: meta.dishCount,
        orderCount: meta.orderCount
      } : null,
      categories: catRes.data,
      orders: orderRes.data
    }
  } catch (err) {
    console.error('bootstrap error', err)
    return {
      success: false,
      error: err.message
    }
  }
}
