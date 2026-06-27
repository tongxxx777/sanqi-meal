const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis'
const DASHSCOPE_TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks'

/**
 * 调用阿里云百炼 wanx-v1 创建图片生成任务
 * @param {string} dishName - 菜品名称
 * @param {string} apiKey - DashScope API Key
 * @returns {Promise<string>} taskId
 */
async function createImageTask(dishName, apiKey) {
  const prompt = `精美的${dishName}菜品，中式美食，餐厅级摆盘，高清美食摄影，白色餐盘，自然光，俯视角度`
  const negativePrompt = '企鹅，动物，人物，文字，水印，低质量，模糊'

  const response = await axios.post(
    DASHSCOPE_API_URL,
    {
      model: 'wanx-v1',
      input: {
        prompt,
        negative_prompt: negativePrompt,
      },
      parameters: {
        n: 2,
        size: '1024*1024',
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      timeout: 15000,
    }
  )

  const taskId = response.data?.output?.task_id
  if (!taskId) {
    throw new Error('创建图片生成任务失败：未返回 task_id')
  }
  return taskId
}

/**
 * 轮询任务状态，直到完成或超时
 * @param {string} taskId - 任务 ID
 * @param {string} apiKey - DashScope API Key
 * @param {number} maxAttempts - 最大轮询次数，默认 20
 * @param {number} interval - 轮询间隔（毫秒），默认 3000
 * @returns {Promise<Array<{url: string}>>} 生成的图片 URL 列表
 */
async function pollTask(taskId, apiKey, maxAttempts = 20, interval = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, interval))

    const response = await axios.get(`${DASHSCOPE_TASK_URL}/${taskId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 10000,
    })

    const output = response.data?.output
    const status = output?.task_status

    console.log(`[AI] 轮询任务 ${taskId}，第 ${attempt} 次，状态：${status}`)

    if (status === 'SUCCEEDED') {
      const results = output.results || []
      if (results.length === 0) {
        throw new Error('任务成功但未返回图片')
      }
      return results
    }

    if (status === 'FAILED') {
      const error = output?.code || output?.message || '未知错误'
      throw new Error(`图片生成任务失败：${error}`)
    }

    // PENDING / RUNNING 继续等待
  }

  throw new Error('图片生成超时，请稍后重试')
}

/**
 * 下载图片并上传到云存储
 * @param {string} imageUrl - 图片 URL（有效期 24 小时）
 * @param {number} index - 图片索引
 * @returns {Promise<{fileID: string, tempFileURL: string}|null>}
 */
async function downloadAndUploadImage(imageUrl, index) {
  try {
    // 下载图片
    const downloadRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    })
    const buffer = Buffer.from(downloadRes.data)

    // 上传到云存储
    const cloudPath = `dishes/ai/${Date.now()}-${index}-${Math.random().toString(36).slice(2)}.jpg`
    const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer })

    // 获取临时访问 URL
    const urlMap = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] })
    const file = urlMap.fileList[0]

    if (file && file.status === 0) {
      return { fileID: file.fileID, tempFileURL: file.tempFileURL }
    }
    return { fileID: uploadRes.fileID, tempFileURL: '' }
  } catch (err) {
    console.error(`[AI] 图片 ${index} 下载/上传失败:`, err.message)
    return null
  }
}

exports.main = async (event, context) => {
  const { dishName } = event

  if (!dishName || !dishName.trim()) {
    return { success: false, message: '菜品名称不能为空' }
  }

  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) {
    return { success: false, message: 'AI 服务未配置，请联系管理员' }
  }

  try {
    console.log(`[AI] 开始为"${dishName}"生成图片...`)

    // 第 1 步：创建图片生成任务
    const taskId = await createImageTask(dishName.trim(), apiKey)
    console.log(`[AI] 任务已创建，taskId: ${taskId}`)

    // 第 2 步：轮询任务状态
    const results = await pollTask(taskId, apiKey)
    console.log(`[AI] 任务完成，生成 ${results.length} 张图片`)

    // 第 3 步：下载图片并上传到云存储
    const images = await Promise.all(
      results.map((item, index) => downloadAndUploadImage(item.url, index))
    )

    // 过滤掉上传失败的图片
    const validImages = images.filter((img) => img !== null)

    if (validImages.length === 0) {
      return { success: false, message: 'AI 图片生成失败，请重试' }
    }

    console.log(`[AI] 最终上传成功: ${validImages.length} 张`)

    return {
      success: true,
      data: { images: validImages, total: validImages.length },
    }
  } catch (e) {
    console.error('[AI] 云函数异常:', e)
    return { success: false, message: '图片生成失败', error: e.message }
  }
}
