/** User and project SSH qualification share the server's revisioned editor. */
import { getSshPolicy, setSshPolicy } from '../api.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function SshPermissions() {
  return <ResourcePermissions name="SSH" read={getSshPolicy} write={setSshPolicy}
    description="默认不授权。个人空间需要用户资格；项目空间同时需要用户资格、项目授权和已共享的连接。SSH 使用目标身份是部署拥有的 OpenSSH 别名；每位用户仍需独立资格。撤权会切断对应运行时的连接。"
    saved="SSH 资格已保存；项目空间仍需同时具备用户资格、项目授权和已共享的连接。" />
}
