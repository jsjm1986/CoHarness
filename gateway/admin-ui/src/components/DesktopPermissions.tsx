/** Project desktop eligibility editor; user qualification lives on the user detail page. */
import { getDesktopPolicy, setDesktopPolicy } from '../api.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function DesktopPermissions() {
  return <ResourcePermissions name="桌面" read={getDesktopPolicy} write={setDesktopPolicy} kinds={['project']}
    description="默认不授权。项目空间同时需要用户资格、项目授权和可写成员身份。资格不替代用户对具体会话与桌面的确认，也不代表运行节点已具备桌面能力。"
    saved="桌面授权已保存；用户仍需确认会话与桌面。" />
}
