// 云函数入口文件 - 发送订阅消息通知
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID

  const { type, dishNames, count, dishName, remark, orderId, templateId, expectText } = event

  if (!templateId) {
    return { success: false, message: '缺少模板ID' }
  }

  // 从 User 集合查询当前用户的伴侣
  let targetOpenid
  try {
    const userRes = await db.collection('User').doc(currentOpenid).get()
    if (!userRes.data || !userRes.data.partnerId) {
      return { success: false, message: '未绑定伴侣' }
    }
    targetOpenid = userRes.data.partnerId
  } catch (err) {
    console.error('query user error', err)
    return { success: false, message: '用户不存在' }
  }

  try {
    let result

    // 根据通知类型发送不同消息
    if (type === 'newOrder') {
      const pagePath = orderId ? `pages/order-detail/index?id=${orderId}` : 'pages/order-history/index'
      result = await cloud.openapi.subscribeMessage.send({
        touser: targetOpenid,
        templateId,
        page: pagePath,
        data: {
          time9: { value: formatTime(new Date()) }, // 时间(精确到分钟)
          thing41: { value: dishNames.substring(0, 20) }, // 提醒内容(菜名)
          // 备注：优先展示期望用餐时间，其次备注，再兜底默认文案
          thing3: { value: buildThing3(expectText, remark) } // 备注
        }
      })
      // 回写推送结果（成功）：用于历史页展示"已通知/未通知"
      if (orderId) {
        await db.collection('OrderList').doc(orderId).update({
          data: { notifyStatus: 'sent', notifyReceiverOpenid: targetOpenid }
        }).catch(e => console.error('回写 notifyStatus=sent 失败', e))
      }
    } else if (type === 'newDish') {
      result = await cloud.openapi.subscribeMessage.send({
        touser: targetOpenid,
        templateId,
        page: 'pages/dishes/index',
        data: {
          time9: { value: formatTime(new Date()) },
          thing41: { value: dishName.substring(0, 20) },
          thing3: { value: '新菜品加入菜单啦~' }
        }
      })
    } else {
      return { success: false, message: '未知通知类型' }
    }
    console.log('发送成功', result)
    return { success: true, result }
  } catch (err) {
    console.error('发送失败', err)
    // 回写推送结果（失败）：用于历史页展示"未通知"
    if (type === 'newOrder' && orderId) {
      await db.collection('OrderList').doc(orderId).update({
        data: { notifyStatus: 'failed', notifyReceiverOpenid: targetOpenid }
      }).catch(e => console.error('回写 notifyStatus=failed 失败', e))
      // 仅当确为"用户额度耗尽/拒收"时，才把接收方标记未订阅；
      // 瞬时错误（网络抖动、openapi 超时、参数异常）不误伤，避免对方已订阅却被永久禁用
      const isQuotaError = err.errCode === 43101 || (err.errMsg && /43101|refuse|额度|user refuse/i.test(String(err.errMsg)))
      if (isQuotaError) {
        await db.collection('User').doc(targetOpenid).update({
          data: { subscribeStatus: 'unsubscribed' }
        }).catch(e => console.error('重置接收方订阅状态失败', e))
      }
    }
    return { success: false, error: err }
  }
}

// 组装通知“备注”字段：期望用餐时间 + 备注，限制 20 字
function buildThing3(expectText, remark) {
  const parts = []
  if (expectText) parts.push(expectText)
  if (remark) parts.push(remark)
  let text = parts.join(' · ')
  if (!text) text = '快来看看今天吃什么~'
  return text.substring(0, 20)
}

// 格式化时间（精确到分钟，北京时间 UTC+8）
function formatTime(date) {
  // 转换为北京时间
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = beijingTime.getUTCFullYear()
  const month = (beijingTime.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = beijingTime.getUTCDate().toString().padStart(2, '0')
  const hours = beijingTime.getUTCHours().toString().padStart(2, '0')
  const minutes = beijingTime.getUTCMinutes().toString().padStart(2, '0')
  return `${year}年${month}月${day}日 ${hours}:${minutes}`
}
