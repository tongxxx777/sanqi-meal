// 云函数入口文件 - 根据邀请码获取邀请人信息（不执行绑定）
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID
  const { inviteCode } = event

  if (!inviteCode || inviteCode.length !== 6) {
    return { success: false, message: '邀请码格式不正确' }
  }

  try {
    // 查询当前用户（用于判断是否已绑定、是否是自己的邀请码）
    const currentUserRes = await db.collection('User').doc(currentOpenid).get().catch(() => null)
    if (!currentUserRes || !currentUserRes.data) {
      return { success: false, message: '请先完成注册' }
    }

    const currentUser = currentUserRes.data

    // 检查当前用户是否已绑定
    if (currentUser.bindStatus === 'bound' && currentUser.partnerId) {
      return { success: false, message: '你已经绑定了伴侣', code: 'ALREADY_BOUND' }
    }

    // 查询邀请码对应的用户
    const partnerRes = await db.collection('User')
      .where({ inviteCode: inviteCode.toUpperCase() })
      .get()

    if (partnerRes.data.length === 0) {
      return { success: false, message: '邀请码不存在，请检查链接是否有效', code: 'NOT_FOUND' }
    }

    const inviter = partnerRes.data[0]

    // 检查是否是自己的邀请码
    if (inviter._id === currentOpenid) {
      return { success: false, message: '不能接受自己创建的邀请', code: 'SELF_INVITE' }
    }

    // 检查对方是否已绑定
    if (inviter.bindStatus === 'bound' && inviter.partnerId) {
      return { success: false, message: 'TA 已经绑定了其他人', code: 'PARTNER_BOUND' }
    }

    return {
      success: true,
      inviter: {
        openid: inviter._id,
        nickname: inviter.nickname || '',
        avatarUrl: inviter.avatarUrl || ''
      }
    }
  } catch (err) {
    console.error('getInviterInfo error', err)
    return {
      success: false,
      message: '获取邀请信息失败',
      error: err.message
    }
  }
}
