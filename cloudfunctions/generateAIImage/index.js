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

  // 返回图片 URL 列表（使用 thumbURL 或 middleURL）
  return validResults.slice(0, count).map(item => item.thumbURL || item.middleURL || item.hoverURL)
}

/**
 * 下载图片并上传到云存储
 * @param {string} imageUrl - 图片 URL
 * @param {number} index - 图片索引
 * @returns {Promise<{fileID: string, tempFileURL: string}|null>}
 */
async function downloadAndUploadImage(imageUrl, index) {
  try {
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
    const cloudPath = `dishes/${Date.now()}-${index}-${Math.random().toString(36).slice(2)}.jpg`
    const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer })

    // 获取临时访问 URL
    const urlMap = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] })
    const file = urlMap.fileList[0]

    if (file && file.status === 0) {
      return { fileID: file.fileID, tempFileURL: file.tempFileURL }
    }
    return { fileID: uploadRes.fileID, tempFileURL: '' }
  } catch (err) {
    console.error(`[搜索图片] 图片 ${index} 下载/上传失败:`, err.message)
    return null
  }
}

exports.main = async (event, context) => {
  const { dishName, refresh } = event

  if (!dishName || !dishName.trim()) {
    return { success: false, message: '菜品名称不能为空' }
  }

  try {
    const name = dishName.trim()
    console.log(`[搜索图片] 开始为"${name}"搜索图片${refresh ? '（刷新）' : ''}...`)

    // 调用百度图片搜索，refresh 时随机翻页
    const imageUrls = await searchBaiduImages(name, 5, refresh)
    console.log(`[搜索图片] 关键词"${name}"，找到 ${imageUrls.length} 张图片`)

    if (!imageUrls || imageUrls.length === 0) {
      return { success: false, message: '未找到相关图片，请手动上传' }
    }

    // 下载图片并上传到云存储（最多2张）
    const images = await Promise.all(
      imageUrls.slice(0, 2).map((url, index) => downloadAndUploadImage(url, index))
    )

    // 过滤掉上传失败的图片
    const validImages = images.filter((img) => img !== null)

    if (validImages.length === 0) {
      return { success: false, message: '图片下载失败，请重试' }
    }

    console.log(`[搜索图片] 最终上传成功: ${validImages.length} 张`)

    return {
      success: true,
      data: { images: validImages, total: validImages.length },
    }
  } catch (e) {
    console.error('[搜索图片] 云函数异常:', e)
    return { success: false, message: '图片搜索失败', error: e.message }
  }
}
