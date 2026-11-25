/**
 * 图片请求的同步计价估算（WorkBuddy / CodeArts 两个模型渠道共用）。
 *
 * DSH 的 token 计量在每次测量时同步调用适配器的 `imageRequestPricing()`，
 * 用它给出的视觉 token 数做预算与结果落盘。宿主写的是
 * `this.adapters.get(p)?.adapter.imageRequestPricing(...)`，可选链只挡「适配器
 * 不存在」，挡不住「适配器存在但没有这个方法」。所以只要适配器声明了
 * `inputModalities: ['text', 'image']` 却没实现它，上下文压缩阶段就会抛
 * `imageRequestPricing is not a function`，连带模型切换一起失败。
 *
 * 两个网关都不公开视觉 token 计价协议，这里给中性估算而非厂商真实消耗：
 * 每张图 1024 token；已被 offload 的图只留描述文本，视觉 token 记 0。
 */

export const FALLBACK_IMAGE_PRICING = Object.freeze({
  /** @param {readonly { offloaded?: boolean }[]} images */
  priceImages(images) {
    return images.map(image => image.offloaded === true
      ? { visualTokens: 0, text: '[image omitted]' }
      : { visualTokens: 1024, text: '[image]' })
  },
})
