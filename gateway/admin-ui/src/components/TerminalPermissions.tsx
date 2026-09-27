/** User and project terminal authorization share the server's revisioned editor. */
import { getTerminalPolicy, setTerminalPolicy } from '../api.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function TerminalPermissions() {
  return <ResourcePermissions name="终端" read={getTerminalPolicy} write={setTerminalPolicy}
    description="默认不授权。个人空间需要用户资格；项目空间同时需要用户资格、项目授权和可写成员身份。终端仅创建者可读写；管理员只能列出和关闭他人的终端。撤权后等待进程清理，隐藏标签不会结束进程。"
    saved="终端资格已保存；项目空间仍需同时具备用户资格、项目授权和可写成员身份。" />
}
