const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 爬取百度图片搜索结果
 * 百度图片对中文支持最好，准确度最高
 * @param {string} keyword - 搜索关键词（中文）
 * @param {number} count - 需要获取的图片数量
 * @returns {Promise<Array<string>>} 图片 URL 列表
 */
async function searchBaiduImages(keyword, count = 5, refresh = false) {
  // 百度图片搜索接口，refresh 时随机翻页获取不同结果
  const searchUrl = 'https://image.baidu.com/search/acjson'
  const page = refresh ? Math.floor(Math.random() * 40) * 10 : 0

  const response = await axios.get(searchUrl, {
    params: {
      tn: 'resultjson_com',
      logid: Date.now(),
      ipn: 'rj',
      ct: 201326592,
      is: '',
      fp: 'result',
      fr: '',
      word: keyword + ' 美食',
      queryWord: keyword + ' 美食',
      cl: 2,
      lm: -1,
      ie: 'utf-8',
      oe: 'utf-8',
      adpicid: '',
      st: -1,
      z: '',
      ic: 0,
      hd: '',
      latest: '',
      copyright: '',
      s: '',
      se: '',
      tab: '',
      width: '',
      height: '',
      face: 0,
      istype: 2,
      jc: '',
      nc: 1,
      pn: page,
      rn: count + 5,
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Referer': 'https://image.baidu.com/',
    },
    timeout: 10000,
  })

  const results = response.data?.data || []
  // 过滤掉无效的图片（百度返回的数据里有一条空数据）
  const validResults = results.filter(item => item && item.thumbURL)

  // 返回原图 URL 列表，前端直接展示，选中后再上传云存储
  return validResults.slice(0, count).map(item => item.thumbURL || item.middleURL || item.hoverURL)
}

/**
 * 下载百度图片并上传到云存储（仅在用户选中后调用）
 * @param {string} imageUrl - 百度图片原始 URL
 * @returns {Promise<{fileID: string, tempFileURL: string}>}
 */
async function downloadAndUploadImage(imageUrl) {
  // 下载图片
  const downloadRes = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://image.baidu.com/',
    },
  })
  const buffer = Buffer.from(downloadRes.data)

  // 上传到云存储（存到 dishes/ 目录）
  const cloudPath = `dishes/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
  const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer })

  // 获取临时访问 URL（用于前端预览，fileID 用于落库）
  const urlMap = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] })
  const file = urlMap.fileList[0]
  const tempFileURL = (file && file.status === 0) ? file.tempFileURL : ''

  return { fileID: uploadRes.fileID, tempFileURL }
}

exports.main = async (event, context) => {
  const { action } = event

  // 上传分支：用户已选中某张百度图片，将其下载并上传到云存储
  if (action === 'upload') {
    const { imageUrl } = event
    if (!imageUrl) {
      return { success: false, message: '缺少 imageUrl 参数' }
    }
    try {
      console.log('[上传图片] 开始下载并上传:', imageUrl)
      const { fileID, tempFileURL } = await downloadAndUploadImage(imageUrl)
      console.log('[上传图片] 上传成功，fileID:', fileID)
      return { success: true, data: { fileID, tempFileURL } }
    } catch (e) {
      console.error('[上传图片] 失败:', e)
      return { success: false, message: '图片上传失败', error: e.message }
    }
  }

  // 搜索分支（默认）：返回百度图片原始 URL 列表，不落云存储
  const { dishName, refresh } = event

  if (!dishName || !dishName.trim()) {
    return { success: false, message: '菜品名称不能为空' }
  }

  try {
    const name = dishName.trim()
    console.log(`[搜索图片] 开始为"${name}"搜索图片${refresh ? '（刷新）' : ''}...`)

    // 调用百度图片搜索，refresh 时随机翻页
    const imageUrls = await searchBaiduImages(name, 2, refresh)
    console.log(`[搜索图片] 关键词"${name}"，找到 ${imageUrls.length} 张图片`)

    if (!imageUrls || imageUrls.length === 0) {
      return { success: false, message: '未找到相关图片，请手动上传' }
    }

    // 只返回百度图片原始 URL，由前端选中后再上传云存储
    // 这样避免「搜了不选」造成云存储堆积孤儿图片
    const images = imageUrls.map((url, index) => ({ url, index }))

    return {
      success: true,
      data: { images, total: images.length },
    }
  } catch (e) {
    console.error('[搜索图片] 云函数异常:', e)
    return { success: false, message: '图片搜索失败', error: e.message }
  }
}
