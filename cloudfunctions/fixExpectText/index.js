const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const SLOT_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }

exports.main = async () => {
  let total = 0, updated = 0, skip = 0
  const PAGE = 100
  while (true) {
    const res = await db.collection('OrderList').limit(PAGE).skip(skip).get()
    const list = res.data
    if (list.length === 0) break
    for (const doc of list) {
      total++
      const slot = doc.expectSlot
      const dateText = (doc.expectDateText || '').trim()
      if (!SLOT_LABEL[slot] && slot !== 'custom') continue // 老数据无档位则跳过，避免误删
      let newExpectText, newExpectTimeText = doc.expectTimeText || ''
      if (slot === 'custom') {
        newExpectText = `${dateText} ${newExpectTimeText}`.trim()
      } else {
        newExpectText = `${dateText} ${SLOT_LABEL[slot]}`.trim()
        newExpectTimeText = ''
      }
      if (newExpectText !== doc.expectText || newExpectTimeText !== (doc.expectTimeText || '')) {
        await db.collection('OrderList').doc(doc._id).update({
          data: { expectText: newExpectText, expectTimeText: newExpectTimeText }
        })
        updated++
      }
    }
    skip += list.length
    if (list.length < PAGE) break
  }
  return { success: true, total, updated }
}
