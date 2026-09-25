/** Desktop eligibility remains separate from personal Session confirmation. */
import { getDesktopPolicy, setDesktopPolicy } from '../api.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function DesktopPermissions() {
  return <ResourcePermissions name="桌面" read={getDesktopPolicy} write={setDesktopPolicy}
    description="默认不授权。个人空间需要用户资格；项目空间同时需要用户资格、项目授权和可写成员身份。资格不替代用户对具体会话与桌面的确认，也不代表运行节点已具备桌面能力。"
    saved="准入资格已保存；用户仍需确认会话与桌面。" />
}
