/** Project plugin-management authorization editor; user qualification lives on the user detail page. */
import { getPluginPolicy, setPluginPolicy } from '../api.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function PluginPermissions() {
  return <ResourcePermissions name="插件管理" read={getPluginPolicy} write={setPluginPolicy} kinds={['project']}
    description="默认不授权。项目空间同时需要用户资格与项目授权；个人空间仅需用户资格。授权不替代插件本身的管理约束与运行时确认。"
    saved="插件管理授权已保存；项目空间仍需同时具备用户资格与项目授权。" />
}
