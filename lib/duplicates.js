/**
 * 重复账号的判定。
 *
 * 华为云的积分额度是**账号级**的，本机的账号池却是「登录一次就多一行」。
 * 在已登录华为云的浏览器里再授权一次，拿到的是全新的临时 AK/SK——看起来是
 * 另一个账号，实际是同一个。结果就是余额显示两遍、标题行把额度加了两次。
 *
 * 判定只能靠身份（`lib/identity.js` 解出的 `account_id`），不能靠 AK/SK，
 * 也不能靠昵称。单独放一个模块是为了能离线测：添加账号那条路径要起 OAuth
 * 回调服务器，整体跑起来太重。
 */

/**
 * 在账号池里找与 `identity` 相同的账号（排除自己）。
 *
 * `identityOf` 是兜底：老账号没存过 `identityKey`，只能现读凭据现算。
 * 它返回 `undefined`（解析不出身份）时**跳过**这一行——不能把「不知道」当成「不同」，
 * 也不能当成「相同」，跳过是唯一安全的选择。
 */
export function findDuplicateAccount(accounts, identity, options = {}) {
  const { selfId, identityOf } = options
  if (identity === undefined || typeof identity?.key !== 'string' || identity.key === '') return undefined
  for (const row of accounts) {
    if (row.id === selfId) continue
    if (row.identityKey === identity.key) return row
    if (typeof identityOf === 'function' && identityOf(row)?.key === identity.key) return row
  }
  return undefined
}

/**
 * 给一组状态行标出重复：同一身份只有第一行算「额度归属」。
 *
 * 不隐藏、不自动删——凭据的去留只能由用户决定；但必须让界面说清
 * 「这两行是同一份额度」，否则标题行的「剩余」会翻倍。
 */
export function markDuplicates(rows) {
  const firstByIdentity = new Map()
  for (const row of rows) {
    const key = row.identity?.key
    if (typeof key !== 'string' || key === '') continue
    const first = firstByIdentity.get(key)
    if (first === undefined) {
      firstByIdentity.set(key, row)
      continue
    }
    row.duplicateOf = first.id
    row.duplicateName = first.nickname || first.id
  }
  return rows
}
